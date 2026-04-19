const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const visionEndpoint = process.env.AZURE_VISION_ENDPOINT || '';
const visionKey = process.env.AZURE_VISION_KEY || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory active parking sessions keyed by normalized license plate.
const activeSessions = new Map();

function normalizePlate(plate) {
  if (!plate || typeof plate !== 'string') return '';
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

function collectOcrTextCandidates(result) {
  const values = [];

  const pushText = (value) => {
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim());
    }
  };

  if (!result || typeof result !== 'object') {
    return values;
  }

  pushText(result.text);
  pushText(result.content);
  pushText(result.readResult?.content);

  (result.readResult?.blocks || []).forEach((block) => {
    (block.lines || []).forEach((line) => {
      pushText(line.text);
      (line.words || []).forEach((word) => pushText(word.text));
    });
  });

  (result.readResult?.pages || []).forEach((page) => {
    (page.lines || []).forEach((line) => {
      pushText(line.content);
      (line.words || []).forEach((word) => pushText(word.content || word.text));
    });
  });

  (result.analyzeResult?.readResults || []).forEach((readResult) => {
    (readResult.lines || []).forEach((line) => {
      pushText(line.text);
      (line.words || []).forEach((word) => pushText(word.text));
    });
  });

  return values;
}

function extractPlateCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  const chunks = rawText
    .toUpperCase()
    .split(/[^A-Z0-9-]+/)
    .map((s) => s.replace(/-/g, ''))
    .filter(Boolean);

  const plateLike = chunks.filter((token) => /^[A-Z0-9]{5,10}$/.test(token));

  if (!plateLike.length) {
    return '';
  }

  plateLike.sort((a, b) => {
    const aMixed = /[A-Z]/.test(a) && /\d/.test(a);
    const bMixed = /[A-Z]/.test(b) && /\d/.test(b);
    if (aMixed !== bMixed) return aMixed ? -1 : 1;
    return b.length - a.length;
  });

  return plateLike[0];
}

// OCR hook for Azure AI Vision. If credentials are missing, returns empty.
async function extractPlateTextFromImage(imageDataUrl) {
  if (!imageDataUrl) {
    return '';
  }

  if (!visionEndpoint || !visionKey) {
    return '';
  }

  const base64Payload = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
  const imageBuffer = Buffer.from(base64Payload, 'base64');

  const endpointBase = visionEndpoint.replace(/\/+$/, '');
  const visionUrl =
    `${endpointBase}/computervision/imageanalysis:analyze` +
    '?api-version=2024-02-01&features=read';

  const response = await fetch(visionUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': visionKey,
      'Content-Type': 'application/octet-stream'
    },
    body: imageBuffer
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Azure OCR failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const textCandidates = collectOcrTextCandidates(result);
  return textCandidates.join(' ');
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

app.get('/api/active', (req, res) => {
  const cars = Array.from(activeSessions.values())
    .map((session) => ({
      plate: session.plate,
      entryTime: session.entryTime,
      entryTimeISO: session.entryTimeISO
    }))
    .sort((a, b) => new Date(a.entryTimeISO) - new Date(b.entryTimeISO));

  res.json({ cars, count: cars.length });
});

app.post('/api/process-plate', async (req, res) => {
  try {
    const { imageData, plateText } = req.body || {};
    const isManualOverride = Boolean(plateText && String(plateText).trim());
    const rawOcrText = isManualOverride ? String(plateText) : await extractPlateTextFromImage(imageData);
    const extractedText = isManualOverride ? String(plateText) : extractPlateCandidate(rawOcrText);
    const normalizedPlate = normalizePlate(extractedText);

    if (!normalizedPlate) {
      const missingVars = [];
      if (!visionEndpoint) missingVars.push('AZURE_VISION_ENDPOINT');
      if (!visionKey) missingVars.push('AZURE_VISION_KEY');
      const hasVisionConfig = missingVars.length === 0;
      return res.status(400).json({
        error: hasVisionConfig
          ? 'No valid license plate text found. Please try another capture with a closer, sharper image.'
          : `OCR is not configured yet. Missing: ${missingVars.join(', ')}. Set them in the same terminal before starting server, or use manual plate override.`
      });
    }

    const now = new Date();

    if (!activeSessions.has(normalizedPlate)) {
      const session = {
        plate: normalizedPlate,
        entryTime: now.toLocaleString(),
        entryTimeISO: now.toISOString()
      };

      activeSessions.set(normalizedPlate, session);

      return res.json({
        event: 'Entry',
        plate: normalizedPlate,
        timestamp: session.entryTime,
        activeCount: activeSessions.size,
        source: isManualOverride ? 'manual' : 'ocr',
        rawOcrText: isManualOverride ? undefined : rawOcrText
      });
    }

    const existingSession = activeSessions.get(normalizedPlate);
    activeSessions.delete(normalizedPlate);

    const exitTime = now.toISOString();
    const durationMs = new Date(exitTime) - new Date(existingSession.entryTimeISO);

    return res.json({
      event: 'Exit',
      plate: normalizedPlate,
      entryTime: existingSession.entryTime,
      exitTime: now.toLocaleString(),
      durationMs,
      durationLabel: formatDuration(durationMs),
      activeCount: activeSessions.size,
      source: isManualOverride ? 'manual' : 'ocr',
      rawOcrText: isManualOverride ? undefined : rawOcrText
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Parking app running on http://localhost:${PORT}`);
});
