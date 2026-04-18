// src/controllers/test.js
const prisma = require('../db');

// ──────────────────────────────────────────────
// Test bosqichini boshlash (session yaratish)
// ──────────────────────────────────────────────
const startTest = async (req, res) => {
  const { token } = req.body;

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: { testSession: { include: { answers: true } } },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (student.status === 'TYPING') {
      return res.status(400).json({ error: 'Avval typing qismini yakunlang' });
    }
    if (student.status !== 'TEST') {
      return res.status(409).json({ error: 'Test allaqachon yakunlangan' });
    }

    // Mavjud session bor bo'lsa — savollar va qolgan vaqt bilan qaytaramiz
    if (student.testSession) {
      const config = await prisma.examConfig.findFirst({ where: { isActive: true } });
      const timeLimitSec = config?.testTimeLimitSec || 1200;

      // Qolgan vaqtni hisoblash
      const elapsedSec = Math.floor((Date.now() - new Date(student.testSession.startedAt).getTime()) / 1000);
      const remainingSec = Math.max(0, timeLimitSec - elapsedSec);

      // Agar vaqt tugagan bo'lsa — avtomatik yakunlash
      if (remainingSec <= 0 && !student.testSession.isCompleted) {
        const correctCount = student.testSession.answers?.filter(a => a.isCorrect)?.length ?? 0;
        await prisma.testSession.update({
          where: { id: student.testSession.id },
          data: { isCompleted: true, finishedAt: new Date(), score: correctCount },
        });
        await prisma.student.update({
          where: { id: student.id },
          data: { status: 'DOCS', testScore: correctCount, totalScore: { increment: correctCount } },
        });
        return res.json({ success: true, completed: true, score: correctCount });
      }

      // Savollarni ham qaytaramiz (refresh uchun)
      const questions = await prisma.testQuestion.findMany({
        where: {
          isActive: true,
          OR: [{ grade: student.grade }, { grade: 0 }],
        },
        select: {
          id: true, questionText: true, imageUrl: true,
          optionA: true, optionB: true, optionC: true, optionD: true, orderIndex: true,
        },
        orderBy: { orderIndex: 'asc' },
        take: 20,
      });

      // Mavjud javoblarni ham qaytaramiz
      const existingAnswers = (student.testSession.answers ?? []).map(a => ({
        questionId: a.questionId,
        selectedOption: a.selectedOption,
      }));

      return res.json({
        success: true,
        data: student.testSession,
        questions,
        existingAnswers,
        timeLimitSec,
        remainingSec,
        alreadyStarted: true,
      });
    }

    const config = await prisma.examConfig.findFirst({ where: { isActive: true } });

    // Sinfga mos savollarni olish (20 ta random)
    const gradeGroup = getGradeGroup(student.grade);
    const questions = await prisma.testQuestion.findMany({
      where: {
        isActive: true,
        OR: [{ grade: student.grade }, { grade: 0 }],
      },
      select: {
        id: true,
        questionText: true,
        imageUrl: true,
        optionA: true,
        optionB: true,
        optionC: true,
        optionD: true,
        orderIndex: true,
      },
      orderBy: { orderIndex: 'asc' },
      take: 20,
    });

    // findFirst + create pattern — upsert muammosini hal qiladi
    let session = await prisma.testSession.findFirst({
      where: { studentId: student.id },
    });
    if (!session) {
      session = await prisma.testSession.create({
        data: { studentId: student.id },
      });
    }

    const timeLimitSec = config?.testTimeLimitSec || 1200;

    res.status(201).json({
      success: true,
      data: session,
      questions,
      timeLimitSec,
      remainingSec: timeLimitSec,  // yangi session — to'liq vaqt
    });
  } catch (err) {
    console.error('Start test error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savollarni olish (boshlangan session uchun)
// ──────────────────────────────────────────────
const getQuestions = async (req, res) => {
  const { token } = req.params;

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      include: {
        testSession: { include: { answers: true } },
      },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (!student.testSession) return res.status(404).json({ error: 'Session topilmadi' });
    if (student.testSession.isCompleted) {
      return res.json({ success: true, completed: true, score: student.testSession.score });
    }

    const questions = await prisma.testQuestion.findMany({
      where: {
        isActive: true,
        OR: [{ grade: student.grade }, { grade: 0 }],
      },
      select: {
        id: true,
        questionText: true,
        imageUrl: true,
        optionA: true,
        optionB: true,
        optionC: true,
        optionD: true,
      },
      take: 20,
    });

    const config = await prisma.examConfig.findFirst({ where: { isActive: true } });
    const elapsed = Math.floor((Date.now() - student.testSession.startedAt.getTime()) / 1000);
    const timeLimit = config?.testTimeLimitSec || 1200;

    res.json({
      success: true,
      questions,
      session: student.testSession,
      timeLimitSec: timeLimit,
      elapsedSec: elapsed,
      remainingSec: Math.max(0, timeLimit - elapsed),
      existingAnswers: student.testSession.answers.map((a) => ({
        questionId: a.questionId,
        selectedOption: a.selectedOption,
      })),
    });
  } catch (err) {
    console.error('Get questions error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Test javoblarini yuborish (submit)
// ──────────────────────────────────────────────
const submitTest = async (req, res) => {
  const { token, answers } = req.body;
  // answers: [{ questionId, selectedOption }]

  if (!token || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Token va javoblar majburiy' });
  }

  try {
    const student = await prisma.student.findUnique({
      where: { token },
      select: { id: true, status: true, testScore: true, testSession: true },
    });

    if (!student) return res.status(404).json({ error: 'Talaba topilmadi' });
    if (!student.testSession) return res.status(404).json({ error: 'Session topilmadi' });
    if (student.testSession.isCompleted) {
      return res.json({ success: true, score: student.testSession.score, alreadySubmitted: true });
    }

    // Barcha savollarni tekshirish
    const questionIds = answers.map((a) => a.questionId);
    const questions = await prisma.testQuestion.findMany({
      where: { id: { in: questionIds } },
      select: { id: true, correctOption: true },
    });

    const correctMap = new Map(questions.map((q) => [q.id, q.correctOption]));
    let correctCount = 0;

    const answerData = answers.map((a) => {
      const isCorrect = correctMap.get(a.questionId) === a.selectedOption;
      if (isCorrect) correctCount++;
      return {
        testSessionId: student.testSession.id,
        questionId: a.questionId,
        selectedOption: a.selectedOption,
        isCorrect,
      };
    });

    const score = parseFloat(correctCount.toFixed(2));

    // Transaction: javoblar + session yakunlash + student yangilash
    // testScore 0 bo'lsa increment qilamiz, aks holda allaqachon hisoblangan
    const prevTestScore = student.testScore ?? 0;
    const scoreDiff = score - prevTestScore;  // ikki marta increment bo'lmaslik uchun

    await prisma.$transaction(async (tx) => {
      // Javoblarni upsert qilamiz — duplicate kelsa yangilaymiz
      for (const a of answerData) {
        await tx.testAnswer.upsert({
          where: {
            testSessionId_questionId: {
              testSessionId: a.testSessionId,
              questionId: a.questionId,
            },
          },
          update: { selectedOption: a.selectedOption, isCorrect: a.isCorrect },
          create: a,
        });
      }

      await tx.testSession.update({
        where: { id: student.testSession.id },
        data: { score, isCompleted: true, finishedAt: new Date() },
      });

      await tx.student.update({
        where: { id: student.id },
        data: {
          status: 'DOCS',
          testScore: score,
          // Faqat yangi qo'shilgan ballni increment qilamiz
          totalScore: scoreDiff !== 0 ? { increment: scoreDiff } : undefined,
        },
      });
    });

    res.json({ success: true, score, correctCount, totalQuestions: answers.length });
  } catch (err) {
    console.error('Submit test error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// Yordamchi funksiya
function getGradeGroup(grade) {
  if (grade <= 6) return '5-6';
  if (grade <= 8) return '7-8';
  return '9-11';
}

module.exports = { startTest, getQuestions, submitTest };