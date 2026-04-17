// src/controllers/docs.js
const prisma = require('../db');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');

// ──────────────────────────────────────────────
// Word fayl yuklash
// ──────────────────────────────────────────────
const uploadDoc = async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(400).json({ error: 'Token majburiy' });
  if (!req.file) return res.status(400).json({ error: 'Fayl yuklanmadi' });

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { docsSubmission: true, testSession: true },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (student.status === 'TYPING' || student.status === 'TEST') {
      return res.status(400).json({ error: 'Avval oldingi bosqichlarni yakunlang' });
    }
    if (student.docsSubmission) {
      return res.status(409).json({ error: 'Siz allaqachon fayl yuklagansiz' });
    }

    const config = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const criteria = config?.docsCriteria ? JSON.parse(config.docsCriteria) : null;

    const filePath = req.file.path;

    // mammoth orqali matn va HTML ni bir vaqtda chiqaramiz
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ path: filePath }),
      mammoth.convertToHtml({ path: filePath }),
    ]);

    const rawText = textResult.value.trim();
    const rawHtml = htmlResult.value;

    // Mezon asosida ball hisoblash
    const { score, feedback } = evaluateDoc(rawText, rawHtml, criteria);

    await prisma.$transaction(async (tx) => {
      await tx.docsSubmission.create({
        data: {
          studentId: student.id,
          fileName: req.file.originalname,
          filePath,
          fileSize: req.file.size,
          score,
          feedback: JSON.stringify(feedback),
          isChecked: true,
          checkedAt: new Date(),
        },
      });

      await tx.student.update({
        where: { id: student.id },
        data: {
          status: 'COMPLETED',
          docsScore: score,
          totalScore: { increment: score },
        },
      });
    });

    res.status(201).json({
      success: true,
      data: { score, feedback, fileName: req.file.originalname },
    });
  } catch (err) {
    console.error('Docs upload error:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Admin: talabaning faylini yuklab olish
// ──────────────────────────────────────────────
const downloadStudentDoc = async (req, res) => {
  const { studentId } = req.params;

  try {
    const submission = await prisma.docsSubmission.findFirst({
      where: { studentId: parseInt(studentId) },
      include: { student: true },
    });

    if (!submission) {
      return res.status(404).json({ error: 'Fayl topilmadi' });
    }

    const filePath = submission.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Fayl serverda topilmadi' });
    }

    const fileName = `${submission.student.lastName}_${submission.student.firstName}_${submission.fileName}`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    console.error('Download doc error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Docs holatini olish
// ──────────────────────────────────────────────
const getDocsStatus = async (req, res) => {
  const { token } = req.params;

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { docsSubmission: true, testSession: true },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });

    const config = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const timeLimitSec = config?.docsTimeLimitSec || 1800;

    let remainingSec = timeLimitSec;
    if (student.testSession?.finishedAt) {
      const elapsedSec = Math.floor(
        (Date.now() - new Date(student.testSession.finishedAt).getTime()) / 1000
      );
      remainingSec = Math.max(0, timeLimitSec - elapsedSec);
    }

    res.json({
      success: true,
      data: {
        status: student.status,
        submission: student.docsSubmission,
        timeLimitSec,
        remainingSec,
        criteria: config?.docsCriteria ? JSON.parse(config.docsCriteria) : null,
      },
    });
  } catch (err) {
    console.error('Docs status error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Hujjat tuzilishini tahlil qilish (mammoth ma'lumotlari asosida)
// ──────────────────────────────────────────────
function analyzeDoc(rawText, rawHtml) {
  const words        = rawText.split(/\s+/).filter(Boolean);
  const sentences    = rawText.split(/[.!?]+/).filter(s => s.trim().length > 3);
  const paragraphs   = rawText.split(/\n\s*\n/).filter(p => p.trim().length > 10);
  const lines        = rawText.split('\n').filter(l => l.trim().length > 0);
  const tableCount   = (rawHtml.match(/<table/gi) ?? []).length;
  const listCount    = (rawHtml.match(/<ul|<ol/gi) ?? []).length;
  const boldCount    = (rawHtml.match(/<strong/gi) ?? []).length;
  const headingCount = (rawHtml.match(/<h[1-6]/gi) ?? []).length;

  // Tinish belgilari soni
  const commas     = (rawText.match(/,/g) ?? []).length;
  const periods    = (rawText.match(/\./g) ?? []).length;
  const allPunct   = (rawText.match(/[.,!?;:—–-]/g) ?? []).length;

  // O'rtacha so'z/gap uzunligi
  const avgWordsPerSentence = sentences.length > 0
    ? Math.round(words.length / sentences.length) : 0;

  // Takroriy so'zlar ulushi (leksik xilma-xillik)
  const uniqueWords   = new Set(words.map(w => w.toLowerCase().replace(/[^a-zA-Zа-яёА-ЯЁ]/g, '')));
  const lexicalRatio  = words.length > 0 ? uniqueWords.size / words.length : 0;

  return {
    wordCount: words.length,
    charCount: rawText.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    lineCount: lines.length,
    tableCount,
    listCount,
    boldCount,
    headingCount,
    commas,
    periods,
    allPunct,
    avgWordsPerSentence,
    lexicalRatio,
    hasTitle: headingCount > 0 || lines[0]?.length < 60,
    hasConclusion: rawText.toLowerCase().includes('xulosa') ||
                   rawText.toLowerCase().includes('conclusion') ||
                   rawText.toLowerCase().includes('yakun'),
    hasIntro: rawText.toLowerCase().includes('kirish') ||
              rawText.toLowerCase().includes('muqaddima') ||
              rawText.toLowerCase().includes('introduction'),
  };
}

// ──────────────────────────────────────────────
// Mezon asosida aqlli baholash
// ──────────────────────────────────────────────
function evaluateDoc(rawText, rawHtml, criteria) {
  const MAX_SCORE = 40;
  const stats = analyzeDoc(rawText, rawHtml);
  const feedback = [];
  let earned = 0;

  // ── Admin mezonlari (baholash_mezonlari formati) ──
  if (criteria?.baholash_mezonlari?.length) {
    criteria.baholash_mezonlari.forEach(mezon => {
      const maxBall = mezon.maksimal_ball ?? 5;
      const nom = (mezon.nomi ?? '').toLowerCase();
      const { ball, hint } = gradeMezon(nom, maxBall, stats, rawText);

      earned += ball;
      feedback.push({
        item: mezon.nomi,
        passed: ball >= maxBall * 0.5,
        points: parseFloat(ball.toFixed(2)),
        maxPoints: maxBall,
        hint: ball >= maxBall ? null : hint,
      });
    });

    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_SCORE), feedback };
  }

  // ── Oddiy items formati ──
  if (criteria?.items?.length) {
    const pointsPerItem = MAX_SCORE / criteria.items.length;
    criteria.items.forEach(item => {
      const keyword  = item.keyword?.toLowerCase();
      const minWords = item.minWords;
      let passed = false;

      if (keyword)       passed = rawText.toLowerCase().includes(keyword);
      else if (minWords) passed = stats.wordCount >= minWords;
      else               passed = true;

      const points = passed ? parseFloat(pointsPerItem.toFixed(2)) : 0;
      earned += points;
      feedback.push({
        item: item.label || keyword || 'Mezon',
        passed, points,
        hint: passed ? null : item.hint || 'Ushbu talabni bajarmadingiz',
      });
    });

    return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_SCORE), feedback };
  }

  // ── Mezon yo'q — umumiy aqlli tekshiruv ──
  const defaults = [
    {
      item: "So'z soni (≥ 150)",
      check: stats.wordCount >= 150,
      partialCheck: stats.wordCount >= 80,
      fullPoints: 10, partialPoints: 5,
      hint: `${stats.wordCount} ta so'z topildi, kamida 150 kerak`,
    },
    {
      item: 'Matn tuzilishi (abzatlar, sarlavha)',
      check: stats.paragraphCount >= 3 && stats.hasTitle,
      partialCheck: stats.paragraphCount >= 2,
      fullPoints: 10, partialPoints: 5,
      hint: `${stats.paragraphCount} ta abzat, sarlavha: ${stats.hasTitle ? 'bor' : 'yo\'q'}`,
    },
    {
      item: 'Tinish belgilari va gap tuzilishi',
      check: stats.allPunct >= 10 && stats.avgWordsPerSentence >= 5,
      partialCheck: stats.allPunct >= 3,
      fullPoints: 10, partialPoints: 5,
      hint: `${stats.allPunct} ta tinish belgisi topildi`,
    },
    {
      item: 'Leksik xilma-xillik',
      check: stats.lexicalRatio >= 0.6 && stats.wordCount >= 50,
      partialCheck: stats.lexicalRatio >= 0.4,
      fullPoints: 10, partialPoints: 5,
      hint: `Leksik ko'rsatkich: ${(stats.lexicalRatio * 100).toFixed(0)}%`,
    },
  ];

  defaults.forEach(d => {
    const points = d.check ? d.fullPoints : d.partialCheck ? d.partialPoints : 0;
    earned += points;
    feedback.push({
      item: d.item,
      passed: d.check,
      points,
      hint: d.check ? null : d.hint,
    });
  });

  return { score: Math.min(parseFloat(earned.toFixed(2)), MAX_SCORE), feedback };
}

// ──────────────────────────────────────────────
// Har bir mezon turini baholash
// ──────────────────────────────────────────────
function gradeMezon(nom, maxBall, stats, rawText) {
  // Imlo / spelling
  if (nom.includes('imlo') || nom.includes('spelling')) {
    // Leksik xilma-xillik va so'z uzunligi orqali baho beramiz
    const ratio = stats.lexicalRatio;
    const avgWordLen = stats.charCount / Math.max(stats.wordCount, 1);
    let ball = 0;
    if (ratio >= 0.70 && avgWordLen >= 4) ball = maxBall;
    else if (ratio >= 0.55 && avgWordLen >= 3.5) ball = maxBall * 0.8;
    else if (ratio >= 0.40) ball = maxBall * 0.6;
    else if (ratio >= 0.25) ball = maxBall * 0.4;
    else ball = maxBall * 0.2;
    return {
      ball,
      hint: ball < maxBall
        ? `Leksik xilma-xillik ${(ratio*100).toFixed(0)}% (yaxshi: ≥70%). Turli so'zlardan ko'proq foydalaning.`
        : null,
    };
  }

  // Grammatika
  if (nom.includes('grammatik') || nom.includes('grammar')) {
    const avg = stats.avgWordsPerSentence;
    let ball = 0;
    if (avg >= 6 && avg <= 20 && stats.sentenceCount >= 5) ball = maxBall;
    else if (avg >= 4 && avg <= 25 && stats.sentenceCount >= 3) ball = maxBall * 0.8;
    else if (stats.sentenceCount >= 2) ball = maxBall * 0.5;
    else ball = maxBall * 0.2;
    return {
      ball,
      hint: ball < maxBall
        ? `Gaplar soni: ${stats.sentenceCount}, o'rtacha uzunlik: ${avg} so'z. To'liq gaplar yozing.`
        : null,
    };
  }

  // Punktuatsiya / tinish
  if (nom.includes('punktuatsiya') || nom.includes('tinish')) {
    const punct = stats.allPunct;
    const ratio = stats.wordCount > 0 ? punct / stats.wordCount : 0;
    let ball = 0;
    if (punct >= 15 && ratio >= 0.05) ball = maxBall;
    else if (punct >= 8) ball = maxBall * 0.8;
    else if (punct >= 4) ball = maxBall * 0.6;
    else if (punct >= 1) ball = maxBall * 0.3;
    else ball = 0;
    return {
      ball,
      hint: ball < maxBall
        ? `${punct} ta tinish belgisi topildi. Vergul, nuqta va boshqa belgilardan foydalaning.`
        : null,
    };
  }

  // Abzat / paragraph / tuzilish
  if (nom.includes('abzat') || nom.includes('paragraph') || nom.includes('tuzilish') || nom.includes('matn')) {
    let ball = 0;
    const p = stats.paragraphCount;
    if (p >= 4 && stats.hasTitle) ball = maxBall;
    else if (p >= 3) ball = maxBall * 0.8;
    else if (p >= 2) ball = maxBall * 0.6;
    else if (p >= 1) ball = maxBall * 0.3;
    else ball = 0;
    return {
      ball,
      hint: ball < maxBall
        ? `${p} ta abzat topildi. Sarlavha: ${stats.hasTitle ? 'bor' : 'yo\'q'}. Matnni bo'limlarga ajrating.`
        : null,
    };
  }

  // Jadval / table
  if (nom.includes('jadval') || nom.includes('table')) {
    let ball = 0;
    if (stats.tableCount >= 2) ball = maxBall;
    else if (stats.tableCount === 1) ball = maxBall * 0.7;
    else ball = 0;
    return {
      ball,
      hint: ball < maxBall
        ? stats.tableCount === 0
          ? 'Jadval topilmadi. Word jadvalidan foydalaning.'
          : 'Faqat 1 ta jadval topildi.'
        : null,
    };
  }

  // Format / ko'rinish / umumiy
  if (nom.includes('format') || nom.includes('ko\'rinish') || nom.includes('rasmiylashtirish')) {
    let ball = 0;
    const hasStructure = stats.boldCount > 0 || stats.headingCount > 0 || stats.listCount > 0;
    const goodLength = stats.wordCount >= 100;
    if (hasStructure && goodLength && stats.paragraphCount >= 3) ball = maxBall;
    else if (goodLength && stats.paragraphCount >= 2) ball = maxBall * 0.7;
    else if (stats.paragraphCount >= 1) ball = maxBall * 0.4;
    else ball = maxBall * 0.2;
    return {
      ball,
      hint: ball < maxBall
        ? `Format elementlari: sarlavhalar(${stats.headingCount}), qalin(${stats.boldCount}), ro'yxat(${stats.listCount}). Formatlashni yaxshilang.`
        : null,
    };
  }

  // Noma'lum mezon — so'z soni asosida
  const ball = stats.wordCount >= 100 ? maxBall * 0.8
    : stats.wordCount >= 50 ? maxBall * 0.5
    : maxBall * 0.2;
  return { ball, hint: `So'zlar soni: ${stats.wordCount}` };
}

module.exports = { uploadDoc, getDocsStatus, downloadStudentDoc };
