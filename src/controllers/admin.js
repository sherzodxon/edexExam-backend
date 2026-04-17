// src/controllers/admin.js
const prisma = require('../db');
const XLSX = require('xlsx');

// ──────────────────────────────────────────────
// Barcha talabalar natijasi
// ──────────────────────────────────────────────
const getResults = async (req, res) => {
  const { grade, status, search } = req.query;

  try {
    const where = {};
    if (grade) where.grade = parseInt(grade);
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { school: { contains: search, mode: 'insensitive' } },
      ];
    }

    const students = await prisma.student.findMany({
      where,
      include: {
        typingAttempts: { orderBy: { attemptNumber: 'asc' } },
        testSession: { select: { score: true, isCompleted: true, startedAt: true, finishedAt: true } },
        docsSubmission: { select: { score: true, fileName: true, isChecked: true } },
      },
      orderBy: { totalScore: 'desc' },
    });

    res.json({ success: true, data: students });
  } catch (err) {
    console.error('Admin get results error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Leaderboard (3 guruh bo'yicha)
// ──────────────────────────────────────────────
const getLeaderboard = async (req, res) => {
  try {
    const groups = {
      '5-6': { grades: [5, 6], label: '5–6 sinf' },
      '7-8': { grades: [7, 8], label: '7–8 sinf' },
      '9-11': { grades: [9, 10, 11], label: '9–11 sinf' },
    };

    const result = {};

    for (const [key, group] of Object.entries(groups)) {
      const students = await prisma.student.findMany({
        where: {
          grade: { in: group.grades },
          status: 'COMPLETED',
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          school: true,
          grade: true,
          typingScore: true,
          testScore: true,
          docsScore: true,
          totalScore: true,
        },
        orderBy: { totalScore: 'desc' },
        take: 50,
      });

      result[key] = {
        label: group.label,
        students: students.map((s, i) => ({ ...s, rank: i + 1 })),
      };
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Test savol yaratish
// ──────────────────────────────────────────────
const createQuestion = async (req, res) => {
  const { grade, questionText, optionA, optionB, optionC, optionD, correctOption, orderIndex } = req.body;

  if (!questionText || !optionA || !optionB || !optionC || !optionD || !correctOption) {
    return res.status(400).json({ error: 'Barcha maydonlar to\'ldirilishi shart' });
  }

  if (!['A', 'B', 'C', 'D'].includes(correctOption)) {
    return res.status(400).json({ error: 'To\'g\'ri javob A, B, C yoki D bo\'lishi kerak' });
  }

  try {
    const question = await prisma.testQuestion.create({
      data: {
        grade: parseInt(grade) || 0,
        questionText,
        optionA,
        optionB,
        optionC,
        optionD,
        correctOption,
        orderIndex: parseInt(orderIndex) || 0,
      },
    });

    res.status(201).json({ success: true, data: question });
  } catch (err) {
    console.error('Create question error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savollar ro'yxati
// ──────────────────────────────────────────────
const getQuestions = async (req, res) => {
  const { grade } = req.query;
  try {
    const where = { isActive: true };
    if (grade) where.grade = parseInt(grade);

    const questions = await prisma.testQuestion.findMany({
      where,
      orderBy: [{ grade: 'asc' }, { orderIndex: 'asc' }],
    });
    res.json({ success: true, data: questions });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Savolni o'chirish
// ──────────────────────────────────────────────
const deleteQuestion = async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.testQuestion.update({
      where: { id: parseInt(id) },
      data: { isActive: false },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Exam config (taymer, mezon) yangilash
// ──────────────────────────────────────────────
const updateConfig = async (req, res) => {
  const { testTimeLimitSec, docsTimeLimitSec, docsCriteria } = req.body;

  try {
    let config = await prisma.examConfig.findFirst({ where: { isActive: true } });

    const data = {};
    if (testTimeLimitSec !== undefined) data.testTimeLimitSec = parseInt(testTimeLimitSec);
    if (docsTimeLimitSec !== undefined) data.docsTimeLimitSec = parseInt(docsTimeLimitSec);
    if (docsCriteria !== undefined) {
      // criteria - array yoki string bo'lishi mumkin
      data.docsCriteria = typeof docsCriteria === 'string' ? docsCriteria : JSON.stringify(docsCriteria);
    }

    if (config) {
      config = await prisma.examConfig.update({ where: { id: config.id }, data });
    } else {
      config = await prisma.examConfig.create({ data });
    }

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('Config update error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Config olish
// ──────────────────────────────────────────────
const getConfig = async (req, res) => {
  try {
    const config = await prisma.examConfig.findFirst({ where: { isActive: true } });
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Talabani o'chirish
// ──────────────────────────────────────────────
const deleteStudent = async (req, res) => {
  const { id } = req.params;
  const studentId = parseInt(id);
  try {
    // Bog'liq jadvallarni ketma-ket o'chirish (FK RESTRICT tufayli)
    await prisma.$transaction(async (tx) => {
      // 1. TestAnswer → TestSession
      const session = await tx.testSession.findFirst({ where: { studentId } });
      if (session) {
        await tx.testAnswer.deleteMany({ where: { testSessionId: session.id } });
        await tx.testSession.delete({ where: { id: session.id } });
      }
      // 2. TypingAttempt
      await tx.typingAttempt.deleteMany({ where: { studentId } });
      // 3. DocsSubmission
      await tx.docsSubmission.deleteMany({ where: { studentId } });
      // 4. Student
      await tx.student.delete({ where: { id: studentId } });
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete student error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

// ──────────────────────────────────────────────
// Excel eksport
// ──────────────────────────────────────────────
const exportExcel = async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      include: {
        typingAttempts: { orderBy: { attemptNumber: 'asc' } },
        testSession: true,
        docsSubmission: true,
      },
      orderBy: { totalScore: 'desc' },
    });

    const rows = students.map((s, i) => {
      const bestAttempt = s.typingAttempts.reduce((best, curr) => (curr.wpm > (best?.wpm || 0) ? curr : best), null);
      return {
        '#': i + 1,
        'Ism': s.firstName,
        'Familiya': s.lastName,
        'Maktab': s.school,
        'Sinf': s.grade,
        'Holat': statusLabel(s.status),
        'Typing WPM': bestAttempt?.wpm || 0,
        'Typing Ball': s.typingScore,
        'Test Ball': s.testScore,
        'Word Ball': s.docsScore,
        'Jami Ball': s.totalScore,
        'Sana': new Date(s.createdAt).toLocaleString('uz-UZ'),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 4 }, { wch: 14 }, { wch: 14 }, { wch: 25 }, { wch: 6 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Natijalar');

    // Guruh varaqalari
    const groups = { '5-6': [5, 6], '7-8': [7, 8], '9-11': [9, 10, 11] };
    for (const [label, grades] of Object.entries(groups)) {
      const groupStudents = students.filter((s) => grades.includes(s.grade));
      const groupRows = groupStudents.map((s, i) => ({
        '#': i + 1,
        'Ism Familiya': `${s.firstName} ${s.lastName}`,
        'Maktab': s.school,
        'Sinf': s.grade,
        'Typing': s.typingScore,
        'Test': s.testScore,
        'Word': s.docsScore,
        'Jami': s.totalScore,
      }));
      const ws2 = XLSX.utils.json_to_sheet(groupRows);
      XLSX.utils.book_append_sheet(wb, ws2, `${label} sinf`);
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="edex-exam-natijalar.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
};

function statusLabel(status) {
  const labels = { TYPING: 'Typing', TEST: 'Test', DOCS: 'Word', COMPLETED: 'Yakunlangan' };
  return labels[status] || status;
}

module.exports = { getResults, getLeaderboard, createQuestion, getQuestions, deleteQuestion, updateConfig, getConfig, deleteStudent, exportExcel };
