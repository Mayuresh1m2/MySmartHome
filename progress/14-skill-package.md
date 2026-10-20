# 14 — Alexa skill package, offline part of aws M3

Date: 2026-10-21

## Goal

The skill manifest and interaction model, so that M3 only has to run the gated ASK CLI steps (create the skill → save its ID → deploy → set the endpoint → enable testing) once the Amazon developer account is ready (G4).

## Checked against current docs

I fetched developer.amazon.com `smapi/skill-manifest`. It confirms the structure (`manifest.publishingInformation.locales.<locale>`, `privacyAndCompliance`, `apis.custom.endpoint.uri` as a Lambda ARN without `sslCertificateType`), three example phrases taken from the sample utterances, `distributionCountries` only when not worldwide, and `SMART_HOME` as a valid category. The page also says **privacy and compliance values must be the owner's own answers**.

## Files

- `skill-package/skill.json`: en-IN, name "Home Hearth", distribution IN only, category SMART_HOME, testing instructions saying development only. The endpoint is a placeholder (`REPLACE_WITH_SkillFunctionArn_STACK_OUTPUT`), so no account ID is committed. It gets set from the stack output at M3 time.
- `skill-package/interactionModels/custom/en-IN.json`: invocation **"home hearth"**; `CommandIntent` with slot `command` of type `COMMAND_TEXT` and the single sample `{command}`; Help, Stop, Cancel, NavigateHome; **no FallbackIntent, no AMAZON.SearchQuery**; 18 varied `COMMAND_TEXT` values.

## For your review

The privacy answers are filled in to match this design: no purchases, no personal info collected, not child-directed, export compliant, no ads. **Please confirm they're your answers.** "usesPersonalInfo: false" is defensible because utterances go only to your own hub, but it's your call.

## Evidence

```text
$ pnpm --filter @hearth/aws test
      Tests  33 passed (33)      (7 new in test/skill-package.test.ts)
```

The tests enforce every skill rule in hearth-aws/CLAUDE.md:

- the locale matches config in both files;
- the invocation name;
- the CommandIntent shape (slot, type, sample);
- exactly the required built-ins, with no Fallback and no SearchQuery;
- 15–20 distinct values;
- every intent in the model is handled in `skill.ts`;
- example phrases use the invocation name;
- no 12-digit account ID in the manifest.
