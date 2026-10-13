# Security research case template

Copy this blank file outside the REA checkout and fill it for one program and
one target artifact. Keep downloaded policies, app packages, test data, and
analysis results in that local case directory; do not commit them to REA.
Use [the guide](authorized-security-research.md) for the workflow and limits.

## Program and policy

- Program name:
- Program platform and URL:
- Participation state and checked at (date/time/time zone):
- Report channel and disclosure rules:
- Applicable policy source URL:
- Policy captured at (date/time/time zone):
- Exact saved policy/scope copy (absolute path):
- Saved policy/scope copy SHA-256:
- Policy version or change date, if stated:
- Unresolved policy questions:

## Exact scope and rules

| Asset kind                                                                | Exact in-scope identifier | Included versions or environment | Source in policy copy |
| ------------------------------------------------------------------------- | ------------------------- | -------------------------------- | --------------------- |
| Android package, iOS bundle, desktop product/build, domain, or API origin |                           |                                  |                       |

- Explicitly excluded identifiers and versions:
- Allowed techniques:
- Prohibited techniques:
- Rate, time, and traffic limits:
- Test account and data rules:
- Privacy and retention rules:
- Other conditions or unknowns:

## Artifact and environment

- Platform and artifact format:
- App/package/bundle identifier:
- Version and build:
- Local absolute artifact path:
- Artifact acquisition source URL or other provenance:
- Artifact acquired at (date/time/time zone):
- Artifact SHA-256:
- Owned test device, OS, and account (if runtime work is permitted):
- Backend or third-party services the app may contact:
- REA and provider versions used:

## Analysis log

| Time | REA command or MCP tool | Target path/digest | Saved output path or Evidence ID | Observed limitation |
| ---- | ----------------------- | ------------------ | -------------------------------- | ------------------- |
|      |                         |                    |                                  |                     |

## Finding candidate (copy for each candidate)

- Candidate ID and concise title:
- Policy snapshot SHA-256 and artifact SHA-256:
- Relevant scope entry:
- Entry point, check, and affected operation or sink:
- Observation with REA Evidence ID and source location:
- Inference, confidence, and competing explanation:
- Unknowns and required follow-up:
- Controlled reproduction in an authorized environment:
- Observed impact and affected versions:
- Sanitized proof and saved output paths:
- Report status and submission reference (if submitted):
