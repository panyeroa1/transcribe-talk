Task ID: T-0001
Title: Configure Supabase and Gemini API for Transcription
Status: TODO
Owner: Miles
Created: 2025-12-15 10:45
Last updated: 2025-12-15 10:45

START LOG

Timestamp: 2025-12-15 10:45
Current behavior:
- Supabase keys are hardcoded in `index.tsx`.
- Gemini API key is accessed via `process.env.API_KEY` (likely incorrect for Vite).
- Transcription saving logic exists but needs verification of configuration.

Plan and scope:
- Updated `.env.local` with provided keys using correct Vite prefixes.
- Update `index.tsx` to use `import.meta.env` variables.
- Ensure Supabase insertion logic aligns with the provided schema.

Files expected to change:
- `index.tsx`
- `.env.local`

Risks:
- Breaking existing hardcoded connection if keys are wrong (will double check).

WORK CHECKLIST
- [x] Update .env.local with provided keys
- [x] Refactor index.tsx to use import.meta.env
- [/] Verify Supabase client initialization
- [/] Verify saveSentence logic

END LOG
