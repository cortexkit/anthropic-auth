---
name: Bug report
about: Report a bug with OpenCode/Pi OAuth support
title: "[BUG]"
labels: bug
assignees: ''

---

> [!IMPORTANT]
> Did you clear your cache and install the latest version before making this report?
>
> `rm -rf ~/.cache/opencode` and checking your `opencode.json` version pin?
>
> Please remove this block to signal that you have tried the above, before posting a bug report.

**Affected integration**
- [ ] OpenCode
- [ ] Pi
- [ ] Both

**Versions**
- Package/plugin version:
- Host agent version:
- OS:

**What is affected?**
- [ ] Login/auth flow
- [ ] Fallback accounts
- [ ] Quotas
- [ ] Prompt cache / cachekeep (cache behavior)
- [ ] Fast mode
- [ ] Dumps (debug dump output)
- [ ] Relay (upstream relay/proxy path)
- [ ] Request rewriting (request transform rules)

**Describe the bug**
A clear and concise description of what happened.

**Steps to reproduce**
1.
2.
3.

**Expected behavior**
What did you expect to happen?

**Sanitized logs/errors**
Paste relevant logs or errors (sanitized).

⚠️ **Do not include secrets**: OAuth access tokens, refresh tokens, local auth files, `.env` values, or mitmproxy/system-prompt captures (captured traffic or prompt dumps).

**Additional context**
Anything else that may help.
