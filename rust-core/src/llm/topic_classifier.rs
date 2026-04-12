use tracing::{info, warn};

use crate::error::IronMicError;
use crate::llm::chat::{ChatMessage, ChatModel};
use crate::llm::cleanup::SharedLlmEngine;
use crate::llm::prompts;
use crate::storage::analytics::AnalyticsStore;

/// Maximum words to send to the LLM for classification (to keep context small).
const MAX_CLASSIFICATION_WORDS: usize = 500;

/// Truncate text to approximately `max_words` words.
fn truncate_text(text: &str, max_words: usize) -> &str {
    let mut end = 0;
    let mut word_count = 0;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            word_count += 1;
            if word_count >= max_words {
                return &text[..i];
            }
        }
        end = i + c.len_utf8();
    }
    &text[..end]
}

/// Parse topic JSON from LLM output. Handles common edge cases.
fn parse_topics(response: &str) -> Vec<(String, f64)> {
    let trimmed = response.trim();

    // Try to find JSON array in the response
    let json_str = if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed[start..].find(']') {
            &trimmed[start..start + end + 1]
        } else {
            trimmed
        }
    } else {
        trimmed
    };

    if let Ok(topics) = serde_json::from_str::<Vec<String>>(json_str) {
        return topics
            .into_iter()
            .filter(|t| !t.is_empty())
            .map(|t| (t, 1.0))
            .collect();
    }

    // Fallback: treat as "General"
    vec![("General".to_string(), 1.0)]
}

/// Classify a single entry's text into topics using the local LLM.
pub fn classify_text(
    llm: &SharedLlmEngine,
    text: &str,
) -> Result<Vec<(String, f64)>, IronMicError> {
    if text.trim().is_empty() {
        return Ok(vec![("General".to_string(), 1.0)]);
    }

    let truncated = truncate_text(text, MAX_CLASSIFICATION_WORDS);
    let prompt = prompts::build_topic_classification_prompt(truncated);

    let messages = vec![
        ChatMessage {
            role: "user".to_string(),
            content: prompt,
        },
    ];

    let response = llm.chat_complete(&messages, &ChatModel::Mistral, 128)?;
    Ok(parse_topics(&response))
}

/// Run a batch of topic classifications on unclassified entries.
/// Returns the number of entries classified.
pub fn classify_batch(
    llm: &SharedLlmEngine,
    analytics: &AnalyticsStore,
    batch_size: u32,
) -> Result<u32, IronMicError> {
    let entries = analytics.get_unclassified_entry_ids(batch_size)?;
    let count = entries.len() as u32;

    if count == 0 {
        info!("No unclassified entries to process");
        return Ok(0);
    }

    info!("Classifying {} entries", count);

    for (entry_id, text) in &entries {
        match classify_text(llm, text) {
            Ok(topics) => {
                analytics.save_entry_topics(entry_id, &topics)?;
            }
            Err(e) => {
                warn!("Failed to classify entry {}: {}", entry_id, e);
                // Save as "General" on failure so we don't retry forever
                analytics.save_entry_topics(
                    entry_id,
                    &[("General".to_string(), 0.5)],
                )?;
            }
        }
    }

    info!("Classified {} entries", count);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_text() {
        let text = "hello world";
        assert_eq!(truncate_text(text, 500), "hello world");
    }

    #[test]
    fn truncate_long_text() {
        let text = "one two three four five six seven eight nine ten";
        let result = truncate_text(text, 5);
        assert_eq!(result, "one two three four five");
    }

    #[test]
    fn parse_topics_valid_json() {
        let response = r#"["Software Development", "Code Review"]"#;
        let topics = parse_topics(response);
        assert_eq!(topics.len(), 2);
        assert_eq!(topics[0].0, "Software Development");
        assert_eq!(topics[1].0, "Code Review");
    }

    #[test]
    fn parse_topics_with_preamble() {
        let response = "Here are the topics:\n[\"Meeting Notes\", \"Project Planning\"]";
        let topics = parse_topics(response);
        assert_eq!(topics.len(), 2);
        assert_eq!(topics[0].0, "Meeting Notes");
    }

    #[test]
    fn parse_topics_invalid_json() {
        let response = "I think this is about software";
        let topics = parse_topics(response);
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].0, "General");
    }

    #[test]
    fn parse_topics_empty() {
        let response = "[]";
        let topics = parse_topics(response);
        assert_eq!(topics.len(), 0);
    }
}
