# Security

Report a suspected vulnerability through [GitHub's private vulnerability reporting](https://github.com/Tlkh201313/fusion-jev/security/advisories/new). Private reporting is enabled for this repository. Avoid posting credentials or evidence contents in public issues.

Fusion treats repository scripts and imported research as untrusted data. Jev receives bounded choices; commands execute only through the host. Local evidence is private, bounded and expiring. Redaction recognizes specified patterns; it does not certify that arbitrary command output contains no secrets. HTTP must retain its explicit authentication and workspace isolation.

A report should include the affected version, minimal reproduction with fake secrets, host/OS/Node versions and the expected trust boundary. The project has no published response-time guarantee.
