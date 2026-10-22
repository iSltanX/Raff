//! «لا تحفظ ما يشبه مفتاحًا سريًا» (IMP-10, experimental, off by default).
//!
//! Recognises a few secrets by shapes that ordinary text practically never
//! has: a PEM private-key header, and four token prefixes with the length
//! that follows them. A copy that holds one is not captured at all — the
//! simplest rule, and the one that keeps the secret off the disk. Anything
//! that merely looks technical (a hash, a UUID, a long word) is not a secret
//! here: a false alarm loses an ordinary copy without a word.

/// Whether `text` holds something shaped like a secret.
pub fn looks_like_secret(text: &str) -> bool {
    has_private_key(text) || text.split(|c: char| !is_token_char(c)).any(is_token)
}

/// `-----BEGIN … PRIVATE KEY-----`: RSA, EC, OpenSSH, PKCS#8, encrypted —
/// and `-----BEGIN PGP PRIVATE KEY BLOCK-----`.
fn has_private_key(text: &str) -> bool {
    text.match_indices("-----BEGIN ").any(|(at, begin)| {
        let rest = &text[at + begin.len()..];
        rest.find("-----").is_some_and(|end| {
            let header = &rest[..end];
            !header.contains('\n')
                && (header.ends_with("PRIVATE KEY") || header.ends_with("PRIVATE KEY BLOCK"))
        })
    })
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// One word, bounded by anything that cannot be part of a token.
fn is_token(word: &str) -> bool {
    let tail = |prefix: &str| word.strip_prefix(prefix);
    // GitHub classic personal access token: ghp_ and 36 more.
    if let Some(rest) = tail("ghp_") {
        return rest.len() >= 36 && rest.chars().all(|c| c.is_ascii_alphanumeric());
    }
    // GitHub fine-grained token.
    if let Some(rest) = tail("github_pat_") {
        return rest.len() >= 22 && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    }
    // AWS access key id: AKIA (long-term) or ASIA (temporary) and exactly
    // 16 upper-case letters or digits.
    if let Some(rest) = tail("AKIA").or_else(|| tail("ASIA")) {
        return rest.len() == 16
            && rest
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    }
    // API keys of the sk- family (sk-…, sk-proj-…, sk-ant-api03-…): one run
    // of 20 or more letters and digits, with a digit in it. Words joined by
    // hyphens («sk-2026-quarterly-planning…») have no such run.
    if let Some(rest) = tail("sk-") {
        return rest.split('-').any(|run| {
            run.len() >= 20
                && run.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && run.chars().any(|c| c.is_ascii_digit())
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic shapes only: none of these is a real credential.
    const GHP: &str = "ghp_0123456789abcdefABCDEF0123456789abcd";

    #[test]
    fn the_shapes_it_knows() {
        assert!(looks_like_secret(GHP));
        assert!(looks_like_secret(&format!("token: {GHP}\n")));
        assert!(looks_like_secret(
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"
        ));
        assert!(looks_like_secret(
            "aws_access_key_id = AKIAABCDEFGHIJ012345"
        ));
        assert!(looks_like_secret(
            "OPENAI_KEY=sk-proj-abcDEF0123456789ghijKLMN"
        ));
        assert!(looks_like_secret("sk-ant-api03-abcdefghij0123456789"));
        assert!(looks_like_secret(
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----"
        ));
        assert!(looks_like_secret("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(looks_like_secret("-----BEGIN ENCRYPTED PRIVATE KEY-----"));
        // Review 2026-10-22.
        assert!(looks_like_secret("-----BEGIN PGP PRIVATE KEY BLOCK-----"));
        assert!(
            looks_like_secret("aws_access_key_id = ASIAABCDEFGHIJ012345"),
            "temporary AWS keys"
        );
    }

    #[test]
    fn ordinary_text_is_not_a_secret() {
        for text in [
            "الاجتماع يوم الأحد الساعة ١٠ ص",
            "ghp_short",
            "ghp_0123456789abcdefABCDEF0123456789abc!", // 35 before the bang
            "AKIA is how AWS keys start",
            "AKIAABCDEFGHIJ0123456", // 17 after the prefix
            "akiaabcdefghij012345",  // lower case
            "sk-learn is a library",
            "risk-assessment-for-the-whole-quarter-2026",
            "task-0123456789abcdefghijk",
            "sk-abcdefghijklmnopqrstuvwxyz", // no digit: a long word
            "-----BEGIN PUBLIC KEY-----",
            "-----BEGIN CERTIFICATE-----",
            "550e8400-e29b-41d4-a716-446655440000",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            // Review 2026-10-22: words joined by hyphens are not a key.
            "sk-2026-quarterly-planning-meeting-notes",
            "sk-hynix-2024-annual-report-final",
            "https://github.com/iSltanX/Raff/releases/latest",
        ] {
            assert!(!looks_like_secret(text), "{text}");
        }
    }
}
