# Voice Copilot --- Personal Speaking Style & Prosody --- Spec

**Status:** Draft\
**Relationship:** Incremental feature spec parallel to
`voice-copilot-mvp`; it does not replace the MVP spec.\
**Suggested repository path:**
`/spec/voice-copilot-speaking-style/spec.md`

## 1. Purpose

This feature extends Voice Copilot from "AI using the user's cloned
voice to read text" toward "AI speaking in a way that resembles how the
user would naturally speak."

It adds two independent but complementary controls:

1.  **Personal Speaking Style** --- controls how an LLM turns Chinese
    meaning into natural spoken English.
2.  **Prosody Controls** --- controls supported TTS acoustic parameters
    such as speaking rate, loudness, and pitch.

The goal is to reduce written-language / broadcast-like / generic-AI
delivery while preserving the existing low-latency Streaming TTS
architecture.

## 2. Product Principles

### 2.1 Separate "what to say", "how the user would phrase it", and "how it sounds"

The product should keep three concepts separate:

``` text
Meaning / Speech Text
        ↓
Personal Speaking Style
        ↓
Spoken English Text
        ↓
Prosody Controls
        ↓
Streaming TTS
        ↓
Cloned Voice
```

-   **Speech Text / Meaning** determines what the user wants to
    communicate.
-   **Personal Speaking Style** determines how the content is phrased as
    spoken language.
-   **Prosody Controls** adjust supported TTS acoustic parameters.
-   **Voice Profile / cloned voice** determines whose voice is
    synthesized.

These layers must not be conflated in the UI or data model.

### 2.2 Direct Speak remains deterministic

When Chinese → English translation is disabled:

``` text
Speech Text → Streaming TTS → Playback
```

The system must not silently invoke an LLM to rewrite, polish, or
"humanize" the user's text.

What the user enters remains the text sent to TTS.

Prosody Controls may still apply because they affect synthesis rather
than text semantics.

### 2.3 Translation mode may produce spoken English

When Chinese → English is enabled:

``` text
Chinese Speech Text
        ↓
LLM: Translation + Spoken-Language Realization
        ↓
Streaming Spoken English
        ↓
Streaming TTS
        ↓
Playback
```

The LLM should not merely produce formal written translation. It should
generate English suitable for speaking naturally in a real meeting while
preserving the source meaning.

This remains a one-shot text transformation for speech output, not a
chatbot or conversational agent.

## 3. User Scenarios

### Scenario A --- Natural English meeting speech

The user enters Chinese content intended for an English-speaking client,
enables Chinese → English, selects a natural speaking style, and clicks
Speak.

Voice Copilot generates accurate but conversational spoken English and
begins Streaming TTS as soon as enough usable English text is available.

### Scenario B --- Professional client communication

The user wants wording that is professional and clear but not overly
formal or broadcast-like.

They select a Professional style and use their cloned voice with their
preferred prosody settings.

### Scenario C --- Concise meeting response

The user wants a shorter, direct spoken response.

They select Concise and the LLM preserves the core meaning while
preferring compact spoken sentences.

### Scenario D --- Personal speaking habits

The user configures My Style with examples and preferences such as
preferred transition phrases, sentence length, and phrases to avoid.

Future translated speech should follow these preferences without
requiring the user to write a prompt every time.

### Scenario E --- Direct internal update

The user enters already-finalized Chinese or English text with
translation disabled.

No LLM modifies the text. The user may still adjust speech rate,
loudness, and pitch before synthesis.

## 4. Speaking Style

### 4.1 Built-in styles

MVP should provide a small set of understandable presets:

-   **Natural Conversation**
-   **Professional**
-   **Concise**
-   **My Style**

The exact prompt implementation is not defined by this spec.

### 4.2 Natural Conversation

Target behavior:

-   sounds suitable for a real video meeting;
-   prefers natural spoken sentence structure;
-   avoids unnecessary written-language formality;
-   may use restrained discourse markers where appropriate;
-   avoids exaggerated enthusiasm and repetitive AI-style filler;
-   preserves business meaning and factual details.

### 4.3 Professional

Target behavior:

-   clear, calm, business-appropriate;
-   professional without sounding like a formal report or press release;
-   favors precise wording and natural spoken rhythm;
-   avoids unnecessary filler.

### 4.4 Concise

Target behavior:

-   preserve essential meaning;
-   prefer shorter spoken sentences;
-   remove redundant wording;
-   do not remove material facts, commitments, numbers, dates, API
    terminology, product names, or other important business details.

### 4.5 My Style

My Style allows the user to define how they normally speak without
requiring prompt-engineering knowledge.

At minimum, the user may provide:

-   free-form speaking preferences;
-   preferred phrases / habitual expressions;
-   phrases or expressions to avoid;
-   example sentences that represent how they naturally speak.

Example inputs may include patterns such as:

``` text
Preferred:
Right, so...
From our side...
I think the main point is...
And next, we'll...

Avoid:
Absolutely!
Certainly!
Furthermore...

Preferences:
Use relatively short sentences.
State the conclusion first, then explain the reason.
Keep the tone calm and practical.
```

The examples above illustrate the type of configuration only; they are
not mandatory default wording.

## 5. Personal Speaking Profile

The system should represent the user's speaking preferences as a
reusable **Personal Speaking Profile**.

A profile may contain:

``` text
stylePreset
speakingPreferences
preferredPhrases
avoidedPhrases
exampleSentences
```

The implementation may refine the exact schema later.

The profile is guidance for LLM spoken-language generation. It must not
be treated as a TTS voice-cloning profile.

### 5.1 User control

Users must be able to edit or clear their Personal Speaking Profile.

The system must not permanently infer new speaking habits from arbitrary
generated output without explicit product behavior and user control.

### 5.2 Meaning preservation

Personalization must not intentionally alter:

-   amounts;
-   dates;
-   names;
-   API fields;
-   URLs;
-   transaction status;
-   commitments;
-   compliance or contractual meaning;
-   other material facts.

Naturalness is subordinate to semantic accuracy.

## 6. LLM Behavior

### 6.1 Single transformation pipeline

For Chinese → English mode, translation and spoken-language realization
should normally happen in the same LLM streaming request:

``` text
Chinese
→ Translation + Speaking Style
→ Streaming Spoken English
→ Streaming TTS
```

The feature should not require a second LLM request solely to "make the
translation conversational" unless a later technical plan demonstrates a
compelling reason.

This protects TTFA and keeps the architecture lightweight.

### 6.2 Streaming requirement

The existing low-latency principle remains:

> Do not wait for the complete translation / spoken-English output
> before starting TTS.

As soon as enough stable, usable spoken-English text is available, it
should be forwarded to the Streaming TTS pipeline according to the
project's existing chunking strategy.

### 6.3 User visibility

Where the product already displays Translated Text, it should display
the actual spoken-English text generated after application of the
selected Speaking Style.

The user should therefore be able to see what Voice Copilot is saying.

## 7. Prosody Controls

Prosody Controls are TTS synthesis controls and are independent of
Personal Speaking Style.

For the current Volcengine bidirectional Streaming TTS capability, the
configurable controls in scope are:

-   **Speech Rate** → `speech_rate`
-   **Loudness** → `loudness_rate`
-   **Pitch** → `post_process.pitch`

The UI should expose these in user-friendly terms rather than requiring
users to know provider field names.

### 7.1 Speech Rate

The user can adjust speaking speed within the range supported by the
provider.

The product should provide a sensible neutral/default value and should
not encourage extreme values that make cloned speech unnatural.

### 7.2 Loudness

The user can adjust synthesized speech loudness within the
provider-supported range.

This is a synthesis setting, not a replacement for the device/system
volume control.

### 7.3 Pitch

The user can adjust synthesized pitch within the provider-supported
range.

Pitch adjustment should be treated as an optional fine-tuning control.
The default should preserve the cloned voice's natural pitch
characteristics.

### 7.4 Persistence

Prosody preferences should be persistable as part of the user's Voice /
speaking configuration so the user does not need to reset them before
every meeting.

The implementation plan should decide whether these values belong to the
existing Voice Profile, a dedicated Prosody Profile, or another
lightweight configuration object.

## 8. Relationship Between Speaking Style and Prosody

Speaking Style and Prosody solve different problems.

Example:

``` text
Speaking Style:
Natural Conversation

Prosody:
Speech Rate = slightly slower
Loudness = neutral
Pitch = neutral
```

Speaking Style influences wording such as:

> "Right, so from our side, the sandbox integration is basically done."

Prosody influences how that already-generated sentence is synthesized.

Changing Prosody must not cause an LLM rewrite.

Changing Speaking Style may change generated English wording when
translation mode is enabled.

## 9. Volcengine Voice-Instruction Boundary

The current product's primary use case is a cloned voice using
Volcengine's voice-cloning model.

The current bidirectional TTS interface documentation states that
`context_texts` voice instructions are supported for designated Doubao
TTS 2.0 voices, while cloned voices that require the model parameter do
not support `context_texts`.

Therefore:

-   this feature must **not** depend on `context_texts` to implement
    Personal Speaking Style for cloned voices;
-   Speaking Style is primarily implemented at the LLM text-generation
    layer;
-   Prosody uses the TTS parameters supported for the selected cloned
    voice;
-   future support for provider-native voice instructions may be added
    only when the selected provider / voice explicitly supports them.

The UI must not misleadingly present LLM text style as a provider-native
TTS voice instruction.

## 10. Settings

Settings should add a lightweight section for speaking personalization.

Suggested information architecture:

``` text
Speaking Style
[ Natural Conversation ▼ ]

My Style
[ speaking preferences                 ]

Preferred phrases
[                                      ]

Phrases to avoid
[                                      ]

Example sentences
[                                      ]

Prosody
Speech Rate   [ control ]
Loudness      [ control ]
Pitch         [ control ]
```

The exact visual layout and control type are implementation decisions.

The main workspace should remain simple. Advanced personalization should
primarily live in Settings rather than crowding the primary Speak
workflow.

## 11. Defaults

The feature must work without any personalization setup.

Recommended product behavior:

-   default Speaking Style: **Natural Conversation** when Chinese →
    English is enabled;
-   default Prosody: neutral provider values;
-   My Style: optional;
-   Direct Speak: no LLM transformation.

The plan may refine exact numeric defaults after testing with real
cloned voices.

## 12. Error and Fallback Behavior

If Personal Speaking Profile data is absent or invalid, fall back to the
selected built-in style.

If a prosody value is invalid or outside the provider-supported range,
prevent submission or normalize it to a valid value.

If the LLM transformation fails in translation mode, preserve the
existing translation-failure behavior; do not silently send the original
Chinese text to an English-only TTS path.

Prosody configuration failure must not expose credentials or other
sensitive provider configuration.

## 13. Out of Scope

This feature does not add:

-   ASR;
-   automatic meeting listening;
-   real-time speech-to-speech;
-   automatic conversation replies;
-   multi-turn chatbot behavior;
-   persona / character role-play;
-   automatic learning from microphone recordings;
-   automatic ingestion of meeting history;
-   voice-clone training workflow;
-   provider-native `context_texts` instructions for cloned voices when
    unsupported;
-   arbitrary AI rewriting of Direct Speak text;
-   Desktop Audio Bridge / Virtual Microphone.

## 14. Acceptance Criteria

The feature is acceptable when all of the following are true:

1.  Chinese → English mode can produce spoken English using Natural
    Conversation, Professional, Concise, or My Style.
2.  Speaking Style is applied within the existing streaming translation
    pipeline rather than requiring the entire translation to finish
    before TTS begins.
3.  Direct Speak remains free of automatic LLM rewriting.
4.  The user can configure and persist personal speaking preferences and
    representative example sentences.
5.  My Style influences generated spoken English while preserving
    material business facts.
6.  The actual generated spoken-English text remains visible to the
    user.
7.  Speech Rate, Loudness, and Pitch are user-configurable and mapped to
    the supported TTS parameters.
8.  Prosody changes do not invoke or require LLM rewriting.
9.  Neutral/default settings continue to work without user
    personalization.
10. The feature does not rely on unsupported `context_texts` voice
    instructions for the cloned-voice path.
11. Existing Streaming TTS, MediaSource/SourceBuffer playback,
    Stop/Replay behavior, and TTFA-oriented architecture remain intact.
12. No Live2D, ASR, meeting-listening, chatbot, or Desktop Audio Bridge
    dependency is introduced.

## 15. Success Criteria

The feature should make Voice Copilot output feel closer to:

> "the user naturally speaking through their cloned voice"

rather than:

> "an AI reading polished text using the user's cloned voice."

Success should be evaluated with repeated A/B listening using the same
source meaning and voice while varying:

-   Speaking Style;
-   My Style personalization;
-   Speech Rate;
-   Pitch;
-   chunking / spoken-text realization where relevant.

The product should prioritize naturalness without sacrificing semantic
accuracy or the low-latency meeting experience.
