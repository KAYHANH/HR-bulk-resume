import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai/node';
import { createServer as createViteServer } from 'vite';

type ResumePayload = {
  id: string;
  content: string;
};

const root = process.cwd();
const isProduction = process.argv.includes('--production');

dotenv.config({ path: resolve(root, '.env.local') });
dotenv.config({ path: resolve(root, '.env') });

const port = Number(process.env.PORT || 3000);
const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';

const app = express();

app.use(express.json({ limit: '20mb' }));

const buildPrompt = (jobDescription: string, resumes: ResumePayload[]) => `Act as an Expert HR Recruiter. Evaluate the following candidate resumes against the job description.
Make a definitive recommendation: 'Hire', 'Shortlist', or 'Reject'.
Output JSON only, containing a 'results' array matching the IDs of the provided resumes.

Job Description:
${jobDescription.substring(0, 5000)}

Resumes to Evaluate:
${resumes.map(resume => `--- RESUME ID: ${resume.id} ---\n${resume.content.substring(0, 4000)}\n`).join('\n')}
`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'The RESUME ID provided in the prompt.' },
          score: { type: Type.INTEGER, description: 'The ATS match score from 0 to 100.' },
          recommendation: { type: Type.STRING, enum: ['Hire', 'Shortlist', 'Reject'] },
          reasoning: { type: Type.STRING },
          foundKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          missingKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['id', 'score', 'recommendation', 'reasoning', 'foundKeywords', 'missingKeywords'],
      },
    },
  },
  required: ['results'],
};

const parseResumes = (input: unknown): ResumePayload[] | null => {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }

  const resumes = input.filter(
    (resume): resume is ResumePayload =>
      Boolean(
        resume &&
        typeof resume === 'object' &&
        'id' in resume &&
        typeof resume.id === 'string' &&
        'content' in resume &&
        typeof resume.content === 'string'
      )
  );

  return resumes.length === input.length ? resumes : null;
};

app.post('/api/analyze', async (req, res) => {
  const jobDescription = typeof req.body?.jobDescription === 'string' ? req.body.jobDescription.trim() : '';
  const resumes = parseResumes(req.body?.resumes);

  if (!jobDescription) {
    return res.status(400).json({ error: 'Job description is required.' });
  }

  if (!resumes) {
    return res.status(400).json({ error: 'At least one valid resume is required.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is missing. Add it to .env.local or .env before analyzing resumes.' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: buildPrompt(jobDescription, resumes),
      config: {
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0.2,
      },
    });

    const parsed = JSON.parse(response.text);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];

    return res.json({ results });
  } catch (error) {
    console.error('Gemini analysis failed:', error);

    const status = typeof error === 'object' && error && 'status' in error && typeof (error as { status?: number }).status === 'number'
      ? (error as { status?: number }).status
      : 500;
    const message = error instanceof Error ? error.message : 'Failed to analyze resumes.';

    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  }
});

const start = async () => {
  if (isProduction) {
    const distPath = resolve(root, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(resolve(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: 'custom',
    });

    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      try {
        const templatePath = resolve(root, 'index.html');
        const template = await readFile(templatePath, 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);

        res.status(200).setHeader('Content-Type', 'text/html').end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
  }

  app.listen(port, () => {
    console.log(`HR bulk resume app running at http://localhost:${port}`);
  });
};

void start();
