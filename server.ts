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

type ATSRecommendation = 'Hire' | 'Shortlist' | 'Reject';

type JobRequirements = {
  requiredSkills: string[];
  preferredSkills: string[];
  roleKeywords: string[];
  minimumYearsExperience: number;
};

type ExtractedResumeEvidence = {
  id: string;
  matchedRequiredSkills: string[];
  inferredRequiredSkills: string[];
  matchedPreferredSkills: string[];
  inferredPreferredSkills: string[];
  matchedRoleKeywords: string[];
  yearsExperience: number;
  evidenceSummary: string;
  inferenceNotes: string[];
};

type ContactDetails = {
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
};

type ScoreBreakdown = {
  requiredSkills: number;
  preferredSkills: number;
  roleFit: number;
  experience: number;
};

type AnalysisResult = {
  id: string;
  score: number;
  recommendation: ATSRecommendation;
  reasoning: string;
  foundKeywords: string[];
  exactMatchedSkills: string[];
  similarMatchedSkills: string[];
  missingKeywords: string[];
  contactDetails: ContactDetails;
  scoreBreakdown: ScoreBreakdown;
  yearsExperience: number;
};

const root = process.cwd();
const isProduction = process.argv.includes('--production');

dotenv.config({ path: resolve(root, '.env.local') });
dotenv.config({ path: resolve(root, '.env') });

const port = Number(process.env.PORT || 3000);
const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';

const app = express();
const jobRequirementsCache = new Map<string, JobRequirements>();

app.use(express.json({ limit: '20mb' }));

const jobRequirementsSchema = {
  type: Type.OBJECT,
  properties: {
    requiredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
    preferredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
    roleKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    minimumYearsExperience: { type: Type.INTEGER },
  },
  required: ['requiredSkills', 'preferredSkills', 'roleKeywords', 'minimumYearsExperience'],
};

const resumeEvidenceSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'The RESUME ID provided in the prompt.' },
          matchedRequiredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
          inferredRequiredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
          matchedPreferredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
          inferredPreferredSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
          matchedRoleKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          yearsExperience: { type: Type.INTEGER },
          evidenceSummary: { type: Type.STRING },
          inferenceNotes: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [
          'id',
          'matchedRequiredSkills',
          'inferredRequiredSkills',
          'matchedPreferredSkills',
          'inferredPreferredSkills',
          'matchedRoleKeywords',
          'yearsExperience',
          'evidenceSummary',
          'inferenceNotes',
        ],
      },
    },
  },
  required: ['results'],
};

const normalizeInteger = (value: unknown): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
};

const normalizeTextValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const normalizeKeywordList = (values: unknown): string[] => {
  if (!Array.isArray(values)) {
    return [];
  }

  const unique = new Map<string, string>();
  values.forEach((value) => {
    const normalized = normalizeTextValue(value);
    if (!normalized) {
      return;
    }

    const key = normalized.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, normalized);
    }
  });

  return Array.from(unique.values());
};

const intersectCanonical = (source: string[], matches: string[]): string[] => {
  const normalizedMatches = new Set(matches.map(match => match.toLowerCase()));
  return source.filter(item => normalizedMatches.has(item.toLowerCase()));
};

const differenceCanonical = (source: string[], matches: string[]): string[] => {
  const normalizedMatches = new Set(matches.map(match => match.toLowerCase()));
  return source.filter(item => !normalizedMatches.has(item.toLowerCase()));
};

const buildJobRequirementsPrompt = (jobDescription: string) => `Extract structured hiring requirements from the job description below.

Rules:
- Capture only explicitly stated requirements.
- Put must-have technologies, tools, languages, frameworks, and certifications into requiredSkills.
- Put nice-to-have or preferred items into preferredSkills.
- Put role names, domain areas, and business-context keywords into roleKeywords.
- Set minimumYearsExperience to the explicit minimum required years only.
- If years of experience are not specified, return 0.
- Use short canonical skill names such as "Java", "React", "MongoDB", "Node.js", "Python", "AWS".
- Return JSON only.

Job Description:
${jobDescription.substring(0, 12000)}
`;

const buildResumeEvidencePrompt = (requirements: JobRequirements, resumes: ResumePayload[]) => `Evaluate the following resumes against the structured job requirements.

Structured Job Requirements:
${JSON.stringify(requirements, null, 2)}

Extraction rules:
- matchedRequiredSkills must only contain items from requiredSkills that are explicitly supported by the resume text.
- inferredRequiredSkills may contain items from requiredSkills that are not explicitly named but are strongly implied by concrete project/work evidence in the resume.
- matchedPreferredSkills must only contain items from preferredSkills that are explicitly supported by the resume text.
- inferredPreferredSkills may contain items from preferredSkills that are not explicitly named but are strongly implied by concrete project/work evidence in the resume.
- matchedRoleKeywords must only contain items from roleKeywords that are explicitly supported by the resume text.
- Only infer a skill when the resume provides strong evidence through projects, responsibilities, architectures, frameworks, or tool usage.
- Never infer a skill from a generic role title alone.
- inferred skills should be conservative and lower-confidence than explicit matches.
- If experience is unclear, return yearsExperience as 0.
- evidenceSummary must be one short paragraph focused on proven skill match or notable skill gaps.
- inferenceNotes should briefly explain why any inferred skills were credited.
- Return JSON only with a results array matching the resume IDs.

Resumes:
${resumes.map(resume => `--- RESUME ID: ${resume.id} ---\n${resume.content.substring(0, 4000)}\n`).join('\n')}
`;

const extractJobRequirements = async (ai: GoogleGenAI, jobDescription: string): Promise<JobRequirements> => {
  const cached = jobRequirementsCache.get(jobDescription);
  if (cached) {
    return cached;
  }

  const response = await ai.models.generateContent({
    model,
    contents: buildJobRequirementsPrompt(jobDescription),
    config: {
      responseMimeType: 'application/json',
      responseSchema: jobRequirementsSchema,
      temperature: 0.1,
    },
  });

  const parsed = JSON.parse(response.text);
  const requirements: JobRequirements = {
    requiredSkills: normalizeKeywordList(parsed?.requiredSkills),
    preferredSkills: normalizeKeywordList(parsed?.preferredSkills),
    roleKeywords: normalizeKeywordList(parsed?.roleKeywords),
    minimumYearsExperience: normalizeInteger(parsed?.minimumYearsExperience),
  };

  jobRequirementsCache.set(jobDescription, requirements);
  return requirements;
};

const extractResumeEvidence = async (
  ai: GoogleGenAI,
  requirements: JobRequirements,
  resumes: ResumePayload[],
): Promise<ExtractedResumeEvidence[]> => {
  const response = await ai.models.generateContent({
    model,
    contents: buildResumeEvidencePrompt(requirements, resumes),
    config: {
      responseMimeType: 'application/json',
      responseSchema: resumeEvidenceSchema,
      temperature: 0.1,
    },
  });

  const parsed = JSON.parse(response.text);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];

  return results.map((result): ExtractedResumeEvidence => ({
    id: normalizeTextValue(result?.id),
    matchedRequiredSkills: intersectCanonical(
      requirements.requiredSkills,
      normalizeKeywordList(result?.matchedRequiredSkills),
    ),
    inferredRequiredSkills: differenceCanonical(
      intersectCanonical(
        requirements.requiredSkills,
        normalizeKeywordList(result?.inferredRequiredSkills),
      ),
      intersectCanonical(
        requirements.requiredSkills,
        normalizeKeywordList(result?.matchedRequiredSkills),
      ),
    ),
    matchedPreferredSkills: intersectCanonical(
      requirements.preferredSkills,
      normalizeKeywordList(result?.matchedPreferredSkills),
    ),
    inferredPreferredSkills: differenceCanonical(
      intersectCanonical(
        requirements.preferredSkills,
        normalizeKeywordList(result?.inferredPreferredSkills),
      ),
      intersectCanonical(
        requirements.preferredSkills,
        normalizeKeywordList(result?.matchedPreferredSkills),
      ),
    ),
    matchedRoleKeywords: intersectCanonical(
      requirements.roleKeywords,
      normalizeKeywordList(result?.matchedRoleKeywords),
    ),
    yearsExperience: normalizeInteger(result?.yearsExperience),
    evidenceSummary: normalizeTextValue(result?.evidenceSummary),
    inferenceNotes: normalizeKeywordList(result?.inferenceNotes),
  }));
};

const extractContactDetails = (resumeText: string): ContactDetails => {
  const emailMatch = resumeText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const linkedInMatch = resumeText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|,)]+/i);
  const githubMatch = resumeText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s|,)]+/i);
  const urlMatches = resumeText.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s|,)]+)?/ig) || [];
  const phoneMatches = resumeText.match(/(?:\+?\d[\d\s().-]{8,}\d)/g) || [];

  const phone = phoneMatches
    .map(match => match.trim())
    .find(match => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    });

  const normalizedUrl = (value?: string) => {
    if (!value) return undefined;
    return value.startsWith('http') ? value : `https://${value}`;
  };

  const portfolio = urlMatches
    .map(match => normalizedUrl(match))
    .find(url => url && !/linkedin\.com|github\.com/i.test(url));

  return {
    email: emailMatch?.[0],
    phone,
    linkedin: normalizedUrl(linkedInMatch?.[0]),
    github: normalizedUrl(githubMatch?.[0]),
    portfolio,
  };
};

const getRecommendationFromScore = (score: number): ATSRecommendation => {
  if (score >= 80) return 'Hire';
  if (score >= 60) return 'Shortlist';
  return 'Reject';
};

const computeScore = (
  requirements: JobRequirements,
  evidence: ExtractedResumeEvidence,
): {
  score: number;
  breakdown: ScoreBreakdown;
  foundKeywords: string[];
  exactMatchedSkills: string[];
  similarMatchedSkills: string[];
  missingKeywords: string[];
} => {
  const weights = {
    requiredSkills: requirements.requiredSkills.length > 0 ? 70 : 0,
    preferredSkills: requirements.preferredSkills.length > 0 ? 15 : 0,
    roleFit: requirements.roleKeywords.length > 0 ? 10 : 0,
    experience: 5,
  };

  const activeWeightTotal = Object.values(weights).reduce((total, weight) => total + weight, 0) || 100;

  const creditedRequiredSkills = normalizeKeywordList([
    ...evidence.matchedRequiredSkills,
    ...evidence.inferredRequiredSkills,
  ]);
  const creditedPreferredSkills = normalizeKeywordList([
    ...evidence.matchedPreferredSkills,
    ...evidence.inferredPreferredSkills,
  ]);

  const requiredRatio = requirements.requiredSkills.length > 0
    ? Math.min(
        (
          evidence.matchedRequiredSkills.length +
          (evidence.inferredRequiredSkills.length * 0.55)
        ) / requirements.requiredSkills.length,
        1
      )
    : 1;
  const preferredRatio = requirements.preferredSkills.length > 0
    ? Math.min(
        (
          evidence.matchedPreferredSkills.length +
          (evidence.inferredPreferredSkills.length * 0.45)
        ) / requirements.preferredSkills.length,
        1
      )
    : 1;
  const roleRatio = requirements.roleKeywords.length > 0
    ? evidence.matchedRoleKeywords.length / requirements.roleKeywords.length
    : 1;
  const experienceRatio = requirements.minimumYearsExperience > 0
    ? Math.min(evidence.yearsExperience / requirements.minimumYearsExperience, 1)
    : 1;

  const breakdown: ScoreBreakdown = {
    requiredSkills: Math.round((weights.requiredSkills / activeWeightTotal) * requiredRatio * 100),
    preferredSkills: Math.round((weights.preferredSkills / activeWeightTotal) * preferredRatio * 100),
    roleFit: Math.round((weights.roleFit / activeWeightTotal) * roleRatio * 100),
    experience: Math.round((weights.experience / activeWeightTotal) * experienceRatio * 100),
  };

  let score = breakdown.requiredSkills + breakdown.preferredSkills + breakdown.roleFit + breakdown.experience;

  if (requirements.requiredSkills.length > 0) {
    if (requiredRatio < 0.35) {
      score = Math.min(score, 45);
    } else if (requiredRatio < 0.6) {
      score = Math.min(score, 59);
    } else if (requiredRatio < 0.85) {
      score = Math.min(score, 79);
    }
  }

  score = Math.max(0, Math.min(100, score));

  const foundKeywords = normalizeKeywordList([
    ...creditedRequiredSkills,
    ...creditedPreferredSkills,
    ...evidence.matchedRoleKeywords,
  ]);
  const exactMatchedSkills = normalizeKeywordList([
    ...evidence.matchedRequiredSkills,
    ...evidence.matchedPreferredSkills,
    ...evidence.matchedRoleKeywords,
  ]);
  const similarMatchedSkills = normalizeKeywordList([
    ...evidence.inferredRequiredSkills,
    ...evidence.inferredPreferredSkills,
  ]);

  const missingKeywords = differenceCanonical(requirements.requiredSkills, creditedRequiredSkills);

  return { score, breakdown, foundKeywords, exactMatchedSkills, similarMatchedSkills, missingKeywords };
};

const buildReasoning = (
  requirements: JobRequirements,
  evidence: ExtractedResumeEvidence,
  missingKeywords: string[],
): string => {
  const statements: string[] = [];

  if (evidence.matchedRequiredSkills.length > 0) {
    statements.push(`Strong required-skill match in ${evidence.matchedRequiredSkills.join(', ')}.`);
  }

  if (evidence.inferredRequiredSkills.length > 0) {
    statements.push(`Project/work evidence suggests likely experience in ${evidence.inferredRequiredSkills.join(', ')}.`);
  }

  if (evidence.matchedPreferredSkills.length > 0) {
    statements.push(`Also matches preferred skills such as ${evidence.matchedPreferredSkills.join(', ')}.`);
  }

  if (evidence.inferredPreferredSkills.length > 0) {
    statements.push(`Supporting project evidence also points to ${evidence.inferredPreferredSkills.join(', ')}.`);
  }

  if (missingKeywords.length > 0) {
    statements.push(`Missing required skills: ${missingKeywords.join(', ')}.`);
  }

  if (requirements.minimumYearsExperience > 0) {
    if (evidence.yearsExperience >= requirements.minimumYearsExperience) {
      statements.push(`Meets the minimum experience requirement with ${evidence.yearsExperience} year${evidence.yearsExperience === 1 ? '' : 's'} of experience.`);
    } else {
      statements.push(`Below the minimum experience requirement: ${evidence.yearsExperience} year${evidence.yearsExperience === 1 ? '' : 's'} versus ${requirements.minimumYearsExperience} required.`);
    }
  }

  if (evidence.evidenceSummary) {
    statements.push(evidence.evidenceSummary);
  }

  if (evidence.inferenceNotes.length > 0) {
    statements.push(`Inference basis: ${evidence.inferenceNotes.join(' ')}`);
  }

  return statements.join(' ');
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
    const requirements = await extractJobRequirements(ai, jobDescription);
    const extractedEvidence = await extractResumeEvidence(ai, requirements, resumes);
    const evidenceById = new Map(extractedEvidence.map(result => [result.id, result]));

    const results: AnalysisResult[] = resumes.map((resume) => {
      const evidence = evidenceById.get(resume.id) || {
        id: resume.id,
        matchedRequiredSkills: [],
        inferredRequiredSkills: [],
        matchedPreferredSkills: [],
        inferredPreferredSkills: [],
        matchedRoleKeywords: [],
        yearsExperience: 0,
        evidenceSummary: 'No structured evidence could be extracted from the resume.',
        inferenceNotes: [],
      };

      const { score, breakdown, foundKeywords, exactMatchedSkills, similarMatchedSkills, missingKeywords } = computeScore(requirements, evidence);
      const recommendation = getRecommendationFromScore(score);

      return {
        id: resume.id,
        score,
        recommendation,
        reasoning: buildReasoning(requirements, evidence, missingKeywords),
        foundKeywords,
        exactMatchedSkills,
        similarMatchedSkills,
        missingKeywords,
        contactDetails: extractContactDetails(resume.content),
        scoreBreakdown: breakdown,
        yearsExperience: evidence.yearsExperience,
      };
    });

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
