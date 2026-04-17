// src/controllers/typing.js
const prisma = require('../db');

const MAX_ATTEMPTS = 3;

const submitAttempt = async (req, res) => {
  const { token, wpm, rawWpm, accuracy, correctWords, totalWords } = req.body;

  if (!token || wpm === undefined || accuracy === undefined) {
    return res.status(400).json({ error: 'Token, WPM va aniqlik majburiy' });
  }
  if (typeof wpm !== 'number' || wpm < 0 || wpm > 500) {
    return res.status(400).json({ error: "WPM noto'g'ri qiymat" });
  }

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { typingAttempts: true },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });

    // Typing allaqachon yakunlangan — muvaffaqiyatli qaytaramiz (duplicate so'rov)
    if (student.status !== 'TYPING') {
      const allAttempts = student.typingAttempts;
      const bestWpm = allAttempts.length
        ? Math.max(...allAttempts.map(a => a.wpm))
        : wpm;
      const bestScore = parseFloat((bestWpm * 0.8).toFixed(2));
      return res.json({ success: true, completed: true, bestScore, bestWpm, duplicate: true });
    }

    const attemptCount = student.typingAttempts.length;
    if (attemptCount >= MAX_ATTEMPTS) {
      return res.status(409).json({ error: '3 ta urinish allaqachon ishlatildi' });
    }

    const score = parseFloat((wpm * 0.8).toFixed(2));
    const attemptNumber = attemptCount + 1;

    const attempt = await prisma.typingAttempt.upsert({
      where: {
        studentId_attemptNumber: {
          studentId: student.id,
          attemptNumber,
        },
      },
      update: { wpm, rawWpm: rawWpm || wpm, accuracy, correctWords: correctWords || 0, totalWords: totalWords || 0, score },
      create: {
        studentId: student.id,
        attemptNumber,
        wpm,
        rawWpm: rawWpm || wpm,
        accuracy,
        correctWords: correctWords || 0,
        totalWords: totalWords || 0,
        score,
      },
    });

    if (attemptNumber === MAX_ATTEMPTS) {
      const allAttempts = [...student.typingAttempts, attempt];
      const bestWpm = Math.max(...allAttempts.map(a => a.wpm));
      const bestScore = parseFloat((bestWpm * 0.8).toFixed(2));

      await prisma.student.update({
        where: { id: student.id },
        data: {
          status: 'TEST',
          typingScore: bestScore,
          totalScore: { increment: bestScore },
        },
      });

      return res.json({ success: true, data: attempt, completed: true, bestScore, bestWpm });
    }

    res.json({ success: true, data: attempt, completed: false, attemptsLeft: MAX_ATTEMPTS - attemptNumber });
  } catch (err) {
    console.error('Typing submit error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

module.exports = { submitAttempt };
