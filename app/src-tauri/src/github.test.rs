use super::*;

fn poll(json: serde_json::Value) -> Poll {
    parse_token_response(&json)
}

#[test]
fn token_response_yields_the_access_token() {
    let Poll::Token(t) =
        poll(serde_json::json!({ "access_token": "ghu_abc", "token_type": "bearer" }))
    else {
        panic!("expected a token");
    };
    assert_eq!(t, "ghu_abc");
}

#[test]
fn in_progress_states_are_not_failures() {
    // GitHub answers 200 with an error body while the user is still authorizing; treating
    // either of these as terminal would abort the flow the moment polling starts.
    assert!(matches!(
        poll(serde_json::json!({ "error": "authorization_pending" })),
        Poll::Pending
    ));
    assert!(matches!(
        poll(serde_json::json!({ "error": "slow_down" })),
        Poll::SlowDown
    ));
}

#[test]
fn terminal_errors_stop_the_flow() {
    for err in ["expired_token", "access_denied", "unsupported_grant_type"] {
        assert!(
            matches!(poll(serde_json::json!({ "error": err })), Poll::Failed(_)),
            "{err} should be terminal"
        );
    }
    // Neither a token nor a recognised error: fail rather than poll forever.
    assert!(matches!(poll(serde_json::json!({})), Poll::Failed(_)));
}

#[test]
fn comments_parse_with_missing_fields() {
    let got = parse_comments(&serde_json::json!([
        { "user": { "login": "ccmdi" }, "body": "hi", "created_at": "2026-08-14T00:00:00Z" },
        {},
    ]));
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].author, "ccmdi");
    assert_eq!(got[0].body, "hi");
    // A malformed entry must not drop the whole thread.
    assert_eq!(got[1].author, "unknown");
    assert_eq!(got[1].body, "");
}

#[test]
fn error_detail_surfaces_the_offending_field() {
    // A 422 is only actionable if the `errors` array survives into the message; without it the
    // user sees "rejected" and nothing else.
    let body = serde_json::json!({
        "message": "Validation Failed",
        "errors": [{ "resource": "Issue", "field": "body", "message": "body is too long" }],
    });
    let got = detail_from(&body, "422 Unprocessable Entity");
    assert!(got.contains("Validation Failed"), "{got}");
    assert!(got.contains("body: body is too long"), "{got}");
}

#[test]
fn error_detail_falls_back_to_the_code_when_there_is_no_message() {
    let body = serde_json::json!({
        "message": "Validation Failed",
        "errors": [{ "field": "title", "code": "missing_field" }],
    });
    assert!(detail_from(&body, "422").contains("title: missing_field"));
}

#[test]
fn error_detail_handles_a_bare_message() {
    let body = serde_json::json!({ "message": "Not Found" });
    let got = detail_from(&body, "404 Not Found");
    assert!(got.contains("404 Not Found"), "{got}");
    assert!(got.contains("Not Found"), "{got}");
}

#[test]
fn comments_parse_tolerates_a_non_array() {
    assert!(parse_comments(&serde_json::json!({ "message": "Not Found" })).is_empty());
}
