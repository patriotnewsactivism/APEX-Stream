# YouTube comment monitoring

Warden reads your channel's live chat and video comments, classifies each one,
and drafts replies you approve. It never posts, hides, deletes or bans on its
own.

## What it does and does not do

| | |
|---|---|
| Reads live chat while you are broadcasting | yes |
| Reads comments on specific videos | yes |
| Classifies each comment and explains why | yes |
| Drafts a reply for you to approve, edit or discard | yes |
| Posts a reply | only the one you pressed send on |
| Hides, deletes, or bans anyone | **no** — not implemented, deliberately |

Marking a comment as a troll records your judgement. It does not act on the
commenter. That is the whole design: the system's job is to make a large volume
of comments reviewable, not to take actions on your behalf.

## Setting it up

You need a Google Cloud project with the YouTube Data API enabled, and an OAuth
client. This takes about ten minutes and only has to be done once.

### 1. Create the Google Cloud project and OAuth client

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library** → search "YouTube Data API v3" → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External** is correct even for personal use.
   - Fill in the app name and your email. You do **not** need to submit for
     verification: while the app is in *Testing*, add your own Google account
     under **Test users** and it works immediately. Verification is only
     required to let *other people's* accounts authorise the app.
   - Add the scope `https://www.googleapis.com/auth/youtube.force-ssl`. This is
     the scope that covers reading comments and replying as your channel.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - Under **Authorised redirect URIs**, add your dashboard's URL with a
     trailing slash — e.g. `https://apexstream.donmatthews.live/`. It has to
     match exactly, including the slash.
   - Save the **Client ID** and **Client secret**.

### 2. Give them to the deployment

> **HISTORICAL — the commands below are for the retired AWS CDK/ECS
> deployment** (the CDK stack that created the named Secrets Manager entry and
> the `ecs update-service` restart no longer exist in this repository).
> APEX-Stream is migrating to Google Cloud Run; until a Cloud-Run-equivalent
> secret-injection path is documented in `docs/PRODUCTION_OPERATIONS.md`, get
> the exact current mechanism from the team rather than assuming these AWS
> commands still apply.

The CDK creates an empty Secrets Manager secret named
`apex/<env>/youtube-oauth`. Fill it in:

```bash
aws secretsmanager put-secret-value \
  --secret-id apex/dev/youtube-oauth \
  --secret-string '{"clientId":"...","clientSecret":"..."}'
```

Then restart the orchestrator and Warden so they pick it up:

```bash
aws ecs update-service --cluster apex-dev --service orchestrator --force-new-deployment
aws ecs update-service --cluster apex-dev --service warden      --force-new-deployment
```

### 3. Connect your channel

Sign in to the dashboard as an **owner** or **administrator** — connecting an
account is restricted to those roles, because the grant it stores can write to
your channel until you revoke it. Go to **Comments** and press
**Connect your YouTube channel**. Google asks you to authorise; you come back to
the dashboard and the connection is stored.

The refresh token is sealed with a KMS-wrapped data key before it is written to
the database (`packages/core/src/security/crypto.ts`), so a database dump alone
discloses nothing usable.

If you ever see "Google returned no refresh token", it means your account has
already granted this app consent and Google withheld the token on the repeat.
Revoke the app at <https://myaccount.google.com/permissions> and connect again.

### 4. Tell it what to watch

Go to **Sources** and add:

- **Live chat** — kind `youtube_live_chat`. Warden follows whatever broadcast
  your channel currently has live; the URL is only a label, so your channel URL
  is fine. Nothing happens while you are not live.
- **A video's comments** — kind `youtube_video`. Paste the video URL. Warden
  reads the comment thread on the interval you set.

## How replies work

1. Warden classifies a comment and, where a reply would help, writes a draft.
2. The draft sits in **Comments → Replies awaiting you**, with the original
   comment above it.
3. You read it, edit it if you want, and press send — or discard it.
4. Only then does anything reach YouTube. The audit ledger records the exact
   text that was sent, whether you edited it, and who approved it.

Warden refuses to draft replies to threats and harassment at all. Those need
your judgement and often a decision about reporting, not a fast public answer.

Most comments get no draft. That is deliberate — a queue full of replies nobody
would send stops being read.

## Tuning it

| Setting | Where | Effect |
|---|---|---|
| `CHANNEL_VOICE` | Warden task env | Free text describing how your channel sounds. The drafter writes to it. |
| `DRAFTER=off` | Warden task env | Classify only, never draft. The queue still works. |
| `CLASSIFIER=keyword` | Warden task env | Use the crude keyword fallback instead of the model. Useful only if Bedrock is unavailable. |
| `CLASSIFIER_MODEL` / `DRAFTER_MODEL` | Warden task env | Bedrock model id. Defaults to `anthropic.claude-opus-5`. |

## Cost and quota

The YouTube Data API grants 10,000 quota units a day by default. Warden is
built around that ceiling: listing live chat costs 1 unit per call and it honours
the polling interval YouTube returns rather than guessing, and it finds your
active broadcast via `liveBroadcasts` (1 unit) rather than `search` (100 units).
A day of continuous broadcasting is comfortably inside the default quota.

Model cost scales with comment volume, not with time. Each comment costs one
classification call, and each drafted reply one more. If a video goes viral and
you want to cap spend, set `DRAFTER=off` — classification alone still gives you
the sorted queue, at roughly half the calls.

## Limits worth knowing

- **Live chat is only readable while you are live.** When the broadcast ends,
  YouTube stops serving its chat, and Warden drops the cursor.
- **Warden runs as a single task.** Live chat has one cursor per source; a second
  task would race the first for the same page and spend the same quota twice.
- **Comment edits are not tracked.** A comment is captured as first seen.
- **This is YouTube only.** Facebook needs a Page (Meta provides no API for
  personal profile comments) and a separate integration — see
  [`ingestion.md`](ingestion.md).
