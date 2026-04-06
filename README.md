# Resume Checker for HR

Resume screening app for HR teams to compare multiple resumes against a job description, rank candidates, and review structured insights before shortlisting.

## What It Does

- Creates reusable screening sessions saved locally in the browser
- Uploads job descriptions and resumes in `.txt`, `.pdf`, `.doc`, and `.docx`
- Extracts structured job requirements from the JD
- Evaluates resumes with a hybrid flow:
  - Gemini extracts evidence from the JD and resume text
  - server-side code calculates the final score
- Shows:
  - `Hire`, `Shortlist`, or `Reject`
  - ATS score
  - scoring insights
  - exact matched skills
  - similar or inferred skills
  - missing keywords
  - contact details when found
- Supports `Re-analyze All` to rerun existing sessions after scoring changes
- Exports processed results to CSV

## Tech Stack

- React 19
- Vite
- Express
- Gemini API via `@google/genai`
- `pdfjs-dist` for PDF parsing
- `mammoth` for Word document parsing
- `idb-keyval` for browser session storage

## How It Works

1. The frontend parses uploaded resumes into text.
2. The frontend sends batches to `POST /api/analyze`.
3. The backend:
   - extracts required skills, preferred skills, role keywords, and minimum experience from the JD
   - extracts explicit and inferred evidence from each resume
   - computes the final score in code
   - derives the recommendation from the final score
4. The UI renders detailed HR insights for each candidate.

This keeps the Gemini API key on the server instead of exposing it in browser code.

## Run Locally

### Prerequisites

- Node.js 20+
- A Gemini API key

### Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env.local` file in the project root:

```env
GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
```

Optional:

```env
PORT=3000
GEMINI_MODEL="gemini-3.1-flash-lite-preview"
```

3. Start the app:

```bash
npm run dev
```

4. Open:

```text
http://localhost:3000
```

## Production-Style Preview

Build the app:

```bash
npm run build
```

Run the production server:

```bash
npm run preview
```

Then open:

```text
http://localhost:3000
```

## Scoring Model

The final ATS score is calculated in code from these categories:

- `Required Skills`
- `Preferred Skills`
- `Role Fit`
- `Experience`

Recommendations are derived from the final score:

- `80+` => `Hire`
- `60-79` => `Shortlist`
- `<60` => `Reject`

Exact matches count more than inferred/project-based matches.

## Notes

- Sessions are stored locally in the browser, not in a database.
- Resume analysis uses the Gemini API and depends on your API quota.
- Image-only PDFs are not fully supported yet because the app currently extracts embedded text rather than OCR.

## Validation

Current local verification used during development:

- `npm run build`

