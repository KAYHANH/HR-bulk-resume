
# Bulk ATS Resume Checker

Analyze and rank multiple resumes against a job description using Gemini AI.

## Run Locally

**Prerequisites:** Node.js 20+

1. Install dependencies:
   `npm install`
2. Create `.env.local` and add your Gemini key:
   `GEMINI_API_KEY="YOUR_GEMINI_API_KEY"`
3. Start the app:
   `npm run dev`

`npm run dev` now starts a single Express server that serves the React app and handles Gemini requests on `/api/analyze`, so the API key stays on the server instead of in the browser bundle.

## Production Preview

1. Build the app:
   `npm run build`
2. Start the production server:
   `npm run preview`
