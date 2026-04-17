// src/routes/index.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { adminAuth } = require('../middleware/auth');
const { register, getProfile } = require('../controllers/student');
const { submitAttempt } = require('../controllers/typing');
const { startTest, getQuestions, submitTest } = require('../controllers/test');
const { uploadDoc, getDocsStatus, downloadStudentDoc } = require('../controllers/docs');
const {
  getResults, getLeaderboard, createQuestion,
  getQuestions: adminGetQuestions, deleteQuestion,
  updateConfig, getConfig, deleteStudent, exportExcel,
} = require('../controllers/admin');

// ── Multer konfiguratsiyasi (Word fayllar uchun) ──
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.docx', '.doc'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Faqat .docx yoki .doc fayllar qabul qilinadi'));
  },
});



// Talaba
router.post('/auth/register', register);
router.get('/student/:token', getProfile);

// Typing
router.post('/typing/attempt', submitAttempt);

// Test
router.post('/test/start', startTest);
router.get('/test/questions/:token', getQuestions);
router.post('/test/submit', submitTest);

// Docs
router.post('/docs/upload', upload.single('file'), uploadDoc);
router.get('/docs/status/:token', getDocsStatus);

// Admin: talaba faylini yuklab olish
router.get('/admin/docs/:studentId/download', adminAuth, downloadStudentDoc);

// Leaderboard (public)
router.get('/leaderboard', getLeaderboard);


router.get('/admin/results', adminAuth, getResults);
router.delete('/admin/students/:id', adminAuth, deleteStudent);
router.get('/admin/export', adminAuth, exportExcel);

// Savollar
router.get('/admin/questions', adminAuth, adminGetQuestions);
router.post('/admin/questions', adminAuth, createQuestion);
router.delete('/admin/questions/:id', adminAuth, deleteQuestion);

// Config
router.get('/admin/config', adminAuth, getConfig);
router.put('/admin/config', adminAuth, updateConfig);

module.exports = router;
 