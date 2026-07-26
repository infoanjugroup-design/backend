const fs = require('fs');
const path = require('path');
const nc = require('./nocodb');
const mailer = require('./mailer');
const { hash, randomSalt, genOtp, uid, getUserRole } = require('./auth');
const { PAPER_SECRET_FIELDS } = require('./schema');
const { uploads } = require('./config');

const ok = (data, message) => ({ status: 'success', message, data });
const err = (message) => ({ status: 'error', message });

function stripPaperFields(rows) {
  return rows.map((r) => {
    const copy = Object.assign({}, r);
    PAPER_SECRET_FIELDS.forEach((f) => { copy[f] = ''; });
    return copy;
  });
}

/* ---------------- database / tables ---------------- */
async function linkDatabase() {
  const data = await nc.ensureAllTables();
  return ok(data, 'Linked');
}
async function getTables() {
  const data = await nc.getTableCounts();
  return ok(data, 'OK');
}
async function getAllRowsAction(p) {
  if (!p.table) return err('Missing table');
  let rows = await nc.getAllRows(p.table);
  if (p.table === 'Tests' || p.table === 'Pyqs') rows = stripPaperFields(rows);
  return { status: 'success', data: rows };
}
async function getManyTables(tables) {
  if (!Array.isArray(tables) || !tables.length) return err('tables must be a non-empty array');
  const data = {};
  for (const t of tables) data[t] = await nc.getAllRows(t);
  return { status: 'success', data };
}

/* ---------------- generic save/delete (covers Courses, Subjects,
   Topics, Tests, Pyqs, Books, and any other simple table) ---------------- */
async function saveGeneric(table, keyCol, row) {
  if (!row) return err('Missing row');
  await nc.saveRow(table, keyCol, row);
  return { status: 'success', message: 'Saved' };
}
async function deleteGeneric(table, keyCol, id) {
  const found = await nc.deleteRow(table, keyCol, id);
  if (!found) return err('Not found');
  return { status: 'success', message: 'Deleted' };
}

/* ---------------- OTP ---------------- */
async function sendOtp(p) {
  if (!p.email || !p.purpose) return err('Missing email/purpose');
  const otp = genOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await nc.appendRow('OTPs', { email: p.email, otp, purpose: p.purpose, expiresAt });
  try {
    await mailer.sendOtpEmail(p.email, p.purpose, otp);
  } catch (e) {
    return err('Could not send email: ' + e.message);
  }
  return { status: 'success', message: 'OTP sent' };
}

async function verifyOtp(p) {
  const rows = await nc.getAllRows('OTPs');
  const normEmail = String(p.email || '').trim().toLowerCase();
  const normOtp = String(p.otp || '').trim();
  const normPurpose = String(p.purpose || '').trim().toLowerCase();
  let sawExpiredMatch = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const rowEmail = String(r.email || '').trim().toLowerCase();
    const rowOtp = String(r.otp || '').trim();
    const rowPurpose = String(r.purpose || '').trim().toLowerCase();
    if (rowEmail === normEmail && rowOtp === normOtp && rowPurpose === normPurpose) {
      if (new Date(r.expiresAt) < new Date()) { sawExpiredMatch = true; continue; }
      return { status: 'success', message: 'OTP verified' };
    }
  }
  if (sawExpiredMatch) return err('OTP expired — click Send OTP again');
  return err('Invalid OTP');
}

/* ---------------- admin / student auth ---------------- */
async function registerAdmin(p) {
  const check = await verifyOtp({ email: p.email, otp: p.otp, purpose: 'studentRegister' });
  if (check.status !== 'success') return check;
  const admins = await nc.getAllRows('Admins');
  const isMainAdmin = admins.length === 0;
  const salt = randomSalt();
  await nc.saveRow('Admins', 'email', {
    email: p.email, name: p.name, passwordHash: hash(p.password, salt), salt,
    isMainAdmin, createdAt: new Date().toISOString(),
  });
  await nc.appendRow('AdminLogs', { timestamp: new Date().toISOString(), event: 'admin_registered', email: p.email });
  return ok({ isMainAdmin }, 'Admin registered');
}

async function adminLogin(p) {
  const otpCheck = await verifyOtp({ email: p.email, otp: p.otp, purpose: 'adminLogin' });
  if (otpCheck.status !== 'success') return otpCheck;
  const admins = await nc.getAllRows('Admins');
  const normEmail = String(p.email || '').trim().toLowerCase();
  const admin = admins.find((a) => String(a.email || '').trim().toLowerCase() === normEmail);
  if (!admin) return err('This email is not registered as an admin');
  if (hash(p.password, admin.salt) !== admin.passwordHash) return err('Incorrect password');
  await nc.appendRow('AdminLogs', { timestamp: new Date().toISOString(), event: 'admin_login', email: p.email });
  return { status: 'success', message: 'Login successful', data: { profile: { email: admin.email, name: admin.name }, isMainAdmin: admin.isMainAdmin } };
}

async function resetPassword(p) {
  const admins = await nc.getAllRows('Admins');
  const admin = admins.find((a) => a.email === p.email);
  if (!admin) return err('This email is not registered as an admin');
  const salt = randomSalt();
  await nc.saveRow('Admins', 'email', Object.assign({}, admin, { passwordHash: hash(p.newPassword, salt), salt }));
  await nc.appendRow('AdminLogs', { timestamp: new Date().toISOString(), event: 'password_reset', email: p.email });
  return { status: 'success', message: 'Password updated' };
}

async function login(p) {
  const role = getUserRole(p.userId);
  if (!role) return err('Invalid User Id format');
  const otpCheck = await verifyOtp({ email: p.email, otp: p.otp, purpose: 'login' });
  if (otpCheck.status !== 'success') return otpCheck;

  if (role === 'student') {
    const students = await nc.getAllRows('Students');
    const normEmail = String(p.email || '').trim().toLowerCase();
    const s = students.find((x) => String(x.email || '').trim().toLowerCase() === normEmail);
    if (!s) return err('Student not found');
    if (s.blocked === true || s.blocked === 'true') return err('This account has been blocked by the admin');
    if (hash(p.password, s.salt) !== s.passwordHash) return err('Incorrect password');
    return { status: 'success', role: 'student', profile: { userId: s.userId, name: s.name, email: s.email } };
  }
  const admins = await nc.getAllRows('Admins');
  const normEmail = String(p.email || '').trim().toLowerCase();
  const a = admins.find((x) => String(x.email || '').trim().toLowerCase() === normEmail);
  if (!a) return err('Admin not found');
  if (hash(p.password, a.salt) !== a.passwordHash) return err('Incorrect password');
  return { status: 'success', role: 'admin', isMainAdmin: a.isMainAdmin, profile: { email: a.email, name: a.name } };
}

async function studentRegister(p) {
  const check = await verifyOtp({ email: p.email, otp: p.otp, purpose: 'studentRegister' });
  if (check.status !== 'success') return check;
  const salt = randomSalt();
  await nc.saveRow('Students', 'userId', {
    userId: p.userId, name: p.name, email: p.email, mobile: p.mobile,
    passwordHash: hash(p.password, salt), salt, blocked: false, createdAt: new Date().toISOString(),
  });
  return { status: 'success', message: 'Account created' };
}

/* ---------------- students management ---------------- */
async function getStudents() {
  const [students, enrollments, courses, studentBooks, books] = await Promise.all([
    nc.getAllRows('Students'), nc.getAllRows('Enrollments'), nc.getAllRows('Courses'),
    nc.getAllRows('StudentBooks'), nc.getAllRows('Books'),
  ]);
  const courseNameById = new Map(courses.map((c) => [c.courseId, c.courseName]));
  const bookNameById = new Map(books.map((b) => [b.bookId, b.bookName]));
  const coursesByStudent = new Map();
  enrollments.forEach((e) => {
    const name = courseNameById.get(e.courseId) || e.courseId;
    if (!coursesByStudent.has(e.userId)) coursesByStudent.set(e.userId, []);
    coursesByStudent.get(e.userId).push(name);
  });
  const booksByStudent = new Map();
  studentBooks.forEach((b) => {
    const name = bookNameById.get(b.bookId) || b.bookId;
    if (!booksByStudent.has(b.studentUserId)) booksByStudent.set(b.studentUserId, []);
    booksByStudent.get(b.studentUserId).push(name);
  });
  const data = students.map((s) => ({
    userId: s.userId, name: s.name, email: s.email, blocked: (s.blocked === true || s.blocked === 'true'),
    courses: coursesByStudent.get(s.userId) || [], books: booksByStudent.get(s.userId) || [],
  }));
  return { status: 'success', data };
}

async function assignBooks(p) {
  if (!p.userId || !Array.isArray(p.bookIds)) return err('Missing userId/bookIds');
  const existing = await nc.getAllRows('StudentBooks');
  for (const row of existing) {
    if (row.studentUserId === p.userId) await nc.deleteRow('StudentBooks', 'studentUserId', p.userId);
  }
  for (const bookId of p.bookIds) await nc.appendRow('StudentBooks', { studentUserId: p.userId, bookId });
  return { status: 'success', message: 'Books assigned' };
}

async function blockStudent(p) {
  const students = await nc.getAllRows('Students');
  const s = students.find((x) => x.userId === p.userId);
  if (!s) return err('Student not found');
  await nc.saveRow('Students', 'userId', Object.assign({}, s, { blocked: !!p.blocked }));
  return { status: 'success', message: p.blocked ? 'Student blocked' : 'Student unblocked' };
}

/* ---------------- lectures (denormalized + composite videoId) ---------------- */
async function saveLecture(p) {
  const row = p.row || {};
  if (!row.topicId) return err('Missing topicId');
  const topics = await nc.getAllRows('Topics');
  const topic = topics.find((t) => t.topicId === row.topicId);
  if (!topic) return err('Topic not found');
  const subjects = await nc.getAllRows('Subjects');
  const subject = subjects.find((s) => s.subjectId === topic.subjectId);
  if (!subject) return err('Subject not found');
  const courses = await nc.getAllRows('Courses');
  const course = courses.find((c) => c.courseId === subject.courseId);
  if (!course) return err('Course not found');

  row.subjectId = subject.subjectId;
  row.courseId = course.courseId;

  if (!row.videoId) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const courseSeq = courses.findIndex((c) => c.courseId === course.courseId) + 1;
    const subjectSeq = subjects.filter((s) => s.courseId === course.courseId).findIndex((s) => s.subjectId === subject.subjectId) + 1;
    const topicSeq = topics.filter((t) => t.subjectId === subject.subjectId).findIndex((t) => t.topicId === topic.topicId) + 1;
    const lectures = await nc.getAllRows('Lectures');
    const videoSeq = lectures.filter((l) => l.topicId === row.topicId).length + 1;
    row.videoId = pad2(courseSeq) + pad2(subjectSeq) + pad2(topicSeq) + pad2(videoSeq);
  }
  await nc.saveRow('Lectures', 'lectureId', row);
  return { status: 'success', message: 'Saved' };
}

/* ---------------- quiz gating (Tests/Pyqs secret fields) ---------------- */
async function courseIdForTopic(topicId) {
  if (!topicId) return null;
  const topics = await nc.getAllRows('Topics');
  const topic = topics.find((t) => t.topicId === topicId);
  if (!topic) return null;
  const subjects = await nc.getAllRows('Subjects');
  const subject = subjects.find((s) => s.subjectId === topic.subjectId);
  return subject ? subject.courseId : null;
}

async function studentCanAccessCourse(userId, courseId) {
  const role = getUserRole(userId);
  if (role === 'admin' || role === 'mainadmin') return true;
  if (!courseId) return false;
  const enrollments = await nc.getAllRows('Enrollments');
  if (enrollments.some((e) => e.userId === userId && e.courseId === courseId)) return true;
  const freeCourses = await nc.getAllRows('FreeCourses');
  return freeCourses.some((fc) => fc.courseId === courseId);
}

async function getQuizPapers(p) {
  if (!p.userId || !p.topicId || !p.kind) return err('Missing data');
  const table = p.kind === 'pyq' ? 'Pyqs' : 'Tests';
  const courseId = await courseIdForTopic(p.topicId);
  if (!(await studentCanAccessCourse(p.userId, courseId))) {
    return err('Aap is course ke liye enrolled nahi hain.');
  }
  const rows = (await nc.getAllRows(table)).filter((x) => x.topicId === p.topicId).map((r) => Object.assign({}, r, { correct: '' }));
  return { status: 'success', data: rows, courseId: courseId || '' };
}

/* ---------------- attempts / performance ---------------- */
async function findAttemptByKey(attemptKey) {
  const rows = await nc.getAllRows('Attempts');
  return rows.find((r) => r.attemptKey === attemptKey) || null;
}

async function bumpPerfSummary(userId, kind, correct, points) {
  const rows = await nc.getAllRows('PerfSummary');
  const existing = rows.find((r) => r.userId === userId);
  const obj = existing || { userId, totalPoints: 0, videoCount: 0, correctCount: 0, wrongCount: 0, doubtPoints: 0, attemptCount: 0 };
  obj.totalPoints = (Number(obj.totalPoints) || 0) + (Number(points) || 0);
  obj.attemptCount = (Number(obj.attemptCount) || 0) + 1;
  if (kind === 'video') obj.videoCount = (Number(obj.videoCount) || 0) + 1;
  else if (kind === 'test' || kind === 'pyq') {
    if (correct === true || correct === 'true') obj.correctCount = (Number(obj.correctCount) || 0) + 1;
    else obj.wrongCount = (Number(obj.wrongCount) || 0) + 1;
  } else if (kind === 'doubt') obj.doubtPoints = (Number(obj.doubtPoints) || 0) + (Number(points) || 0);
  await nc.saveRow('PerfSummary', 'userId', obj);
}

async function bumpPerfSummaryPaper(userId, correctCount, wrongCount, points) {
  const rows = await nc.getAllRows('PerfSummary');
  const existing = rows.find((r) => r.userId === userId);
  const obj = existing || { userId, totalPoints: 0, videoCount: 0, correctCount: 0, wrongCount: 0, doubtPoints: 0, attemptCount: 0 };
  obj.totalPoints = (Number(obj.totalPoints) || 0) + points;
  obj.attemptCount = (Number(obj.attemptCount) || 0) + 1;
  obj.correctCount = (Number(obj.correctCount) || 0) + correctCount;
  obj.wrongCount = (Number(obj.wrongCount) || 0) + wrongCount;
  await nc.saveRow('PerfSummary', 'userId', obj);
}

async function appendAttempt(userId, kind, refId, courseId, correct, points) {
  const attemptKey = `${userId}|${kind}|${refId}`;
  await nc.appendRow('Attempts', {
    attemptId: uid('ATT'), userId, kind, refId, courseId: courseId || '',
    correct: (correct === '' || correct == null) ? '' : !!correct, points,
    createdAt: new Date().toISOString(), attemptKey,
  });
  await bumpPerfSummary(userId, kind, correct, points);
}

async function logVideoWatch(p) {
  if (!p.userId || !p.lectureId) return err('Missing data');
  if (await findAttemptByKey(`${p.userId}|video|${p.lectureId}`)) return ok({ points: 0 }, 'Already counted');
  await appendAttempt(p.userId, 'video', p.lectureId, p.courseId || '', '', 3);
  return ok({ points: 3 }, '+3 points');
}

async function submitAnswer(p) {
  if (!p.userId || !p.refId || !p.kind) return err('Missing data');
  const table = p.kind === 'pyq' ? 'Pyqs' : 'Tests';
  const idField = p.kind === 'pyq' ? 'pyqId' : 'testId';
  const q = (await nc.getAllRows(table)).find((x) => x[idField] === p.refId);
  if (!q) return err('Question not found');
  const already = await findAttemptByKey(`${p.userId}|${p.kind}|${p.refId}`);
  if (already) {
    return { status: 'success', data: { alreadyAnswered: true, correct: (already.correct === true || already.correct === 'true'), correctAnswer: q.correct, points: 0 } };
  }
  const isCorrect = String(p.selected || '').trim().toUpperCase() === String(q.correct || '').trim().toUpperCase();
  const points = isCorrect ? 1 : -1;
  await appendAttempt(p.userId, p.kind, p.refId, p.courseId || '', isCorrect, points);
  return { status: 'success', data: { alreadyAnswered: false, correct: isCorrect, correctAnswer: q.correct, points } };
}

async function logPaperAttempt(p) {
  if (!p.userId || !p.refId || !p.kind) return err('Missing data');
  const attemptKey = `${p.userId}|${p.kind}|${p.refId}`;
  if (await findAttemptByKey(attemptKey)) return ok({ alreadyAttempted: true, points: 0 }, 'Already logged');
  const correctCount = Number(p.correctCount) || 0;
  const wrongCount = Number(p.wrongCount) || 0;
  const points = Number(p.points) || 0;
  await nc.appendRow('Attempts', {
    attemptId: uid('ATT'), userId: p.userId, kind: p.kind, refId: p.refId, courseId: p.courseId || '',
    correct: '', points, createdAt: new Date().toISOString(), attemptKey,
  });
  await bumpPerfSummaryPaper(p.userId, correctCount, wrongCount, points);
  return ok({ alreadyAttempted: false, points }, 'Logged');
}

async function getPaperAttempts(p) {
  if (!p.kind || !p.refId) return err('Missing kind/refId');
  const [attempts, students] = await Promise.all([nc.getAllRows('Attempts'), nc.getAllRows('Students')]);
  const matched = attempts.filter((a) => a.kind === p.kind && a.refId === p.refId);
  const nameById = new Map(students.map((s) => [s.userId, s.name]));
  const data = matched.map((a) => ({
    userId: a.userId, name: nameById.get(a.userId) || '',
    correct: (a.correct === true || a.correct === 'true'), points: Number(a.points) || 0, attemptedAt: a.createdAt,
  }));
  return { status: 'success', data };
}

async function backfillPerfSummary() {
  const attempts = await nc.getAllRows('Attempts');
  const byUser = new Map();
  attempts.forEach((a) => {
    if (!byUser.has(a.userId)) byUser.set(a.userId, { userId: a.userId, totalPoints: 0, videoCount: 0, correctCount: 0, wrongCount: 0, doubtPoints: 0, attemptCount: 0 });
    const s = byUser.get(a.userId);
    const pts = Number(a.points) || 0;
    s.totalPoints += pts;
    s.attemptCount++;
    if (a.kind === 'video') s.videoCount++;
    else if (a.kind === 'test' || a.kind === 'pyq') { (a.correct === true || a.correct === 'true') ? s.correctCount++ : s.wrongCount++; }
    else if (a.kind === 'doubt') s.doubtPoints += pts;
  });
  for (const s of byUser.values()) await nc.saveRow('PerfSummary', 'userId', s);
  return { status: 'success', message: `Rebuilt PerfSummary for ${byUser.size} student(s)` };
}

async function getPerformance(p) {
  if (!p.userId) return err('Missing userId');
  const rows = await nc.getAllRows('PerfSummary');
  const s = rows.find((x) => x.userId === p.userId);
  if (!s) return ok({ totalPoints: 0, videoCount: 0, correctCount: 0, wrongCount: 0, doubtPoints: 0, attemptCount: 0 });
  return ok({
    totalPoints: Number(s.totalPoints) || 0, videoCount: Number(s.videoCount) || 0,
    correctCount: Number(s.correctCount) || 0, wrongCount: Number(s.wrongCount) || 0,
    doubtPoints: Number(s.doubtPoints) || 0, attemptCount: Number(s.attemptCount) || 0,
  });
}

/* ---------------- payments / purchases / bills ---------------- */
async function savePaymentSettings(p) {
  const row = Object.assign({ id: 'main' }, p.row, { updatedAt: new Date().toISOString() });
  await nc.saveRow('PaymentSettings', 'id', row);
  return { status: 'success', message: 'Payment details saved' };
}
async function getPaymentSettings() {
  const rows = await nc.getAllRows('PaymentSettings');
  return { status: 'success', data: rows[0] || null };
}
async function saveTransaction(p) {
  await nc.appendRow('Purchases', {
    purchaseId: uid('PUR'), userId: p.userId, courseId: p.courseId, transactionId: p.transactionId,
    paymentMethod: p.paymentMethod || '', amount: p.amount || '', status: 'pending', billNo: '',
    createdAt: new Date().toISOString(), verifiedAt: '',
  });
  return { status: 'success', message: 'Transaction submitted — awaiting verification' };
}
async function getPurchases() {
  const [purchases, students, courses] = await Promise.all([nc.getAllRows('Purchases'), nc.getAllRows('Students'), nc.getAllRows('Courses')]);
  const studentById = new Map(students.map((s) => [s.userId, s]));
  const courseById = new Map(courses.map((c) => [c.courseId, c]));
  const data = purchases.map((pu) => {
    const s = studentById.get(pu.userId);
    const c = courseById.get(pu.courseId);
    return Object.assign({}, pu, { studentName: s ? s.name : pu.userId, studentEmail: s ? s.email : '', courseName: c ? c.courseName : pu.courseId });
  });
  return { status: 'success', data };
}
async function verifyPurchase(p) {
  const purchases = await nc.getAllRows('Purchases');
  const pu = purchases.find((x) => x.purchaseId === p.purchaseId);
  if (!pu) return err('Purchase not found');
  if (pu.status === 'verified') return err('Already verified');
  const students = await nc.getAllRows('Students');
  const s = students.find((x) => x.userId === pu.userId);
  if (!s) return err('Student not found');
  const courses = await nc.getAllRows('Courses');
  const c = courses.find((x) => x.courseId === pu.courseId);

  const billNo = 'GATE99-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const issuedAt = new Date().toISOString();
  await nc.appendRow('Bills', { billId: uid('BILL'), userId: pu.userId, courseId: pu.courseId, billNo, amount: pu.amount || '', issuedAt });
  await nc.saveRow('Purchases', 'purchaseId', Object.assign({}, pu, { status: 'verified', billNo, verifiedAt: issuedAt }));
  await nc.appendRow('Enrollments', { userId: pu.userId, courseId: pu.courseId, purchasedAt: issuedAt });

  const courseName = c ? c.courseName : pu.courseId;
  const subject = `GATE99 — Payment verified: Bill ${billNo}`;
  const body = `Hi ${s.name},\n\nYour payment for ${courseName} has been verified.\n\nBill No: ${billNo}\nCourse: ${courseName}\nAmount: Rs. ${pu.amount || '-'}\nTransaction ID: ${pu.transactionId}\nDate: ${issuedAt}\n\nYou now have full access to this course on GATE99.`;
  await mailer.sendPlainEmail(s.email, subject, body);
  return ok({ billNo }, 'Verified — bill sent to student');
}

/* ---------------- feedback ---------------- */
async function submitFeedback(p) {
  await nc.appendRow('Feedbacks', {
    feedbackId: uid('FB'), userId: p.userId, name: p.name || '', email: p.email || '', message: p.message || '',
    attachmentUrl: p.attachmentUrl || '', status: 'open', reply: '', repliedAt: '', createdAt: new Date().toISOString(),
  });
  return { status: 'success', message: 'Feedback submitted' };
}
async function replyFeedback(p) {
  const feedbacks = await nc.getAllRows('Feedbacks');
  const fb = feedbacks.find((x) => x.feedbackId === p.feedbackId);
  if (!fb) return err('Feedback not found');
  const repliedAt = new Date().toISOString();
  await nc.saveRow('Feedbacks', 'feedbackId', Object.assign({}, fb, { reply: p.reply || '', repliedAt, attachmentUrl: p.attachmentUrl || fb.attachmentUrl }));
  if (fb.email) {
    const body = `Hi ${fb.name || 'there'},\n\nReply to your feedback on GATE99:\n\n${p.reply || ''}${p.attachmentUrl ? `\n\nAttachment: ${p.attachmentUrl}` : ''}`;
    await mailer.sendPlainEmail(fb.email, 'GATE99 — Reply to your feedback', body);
  }
  return { status: 'success', message: 'Reply sent' };
}
async function resolveFeedback(p) {
  const feedbacks = await nc.getAllRows('Feedbacks');
  const fb = feedbacks.find((x) => x.feedbackId === p.feedbackId);
  if (!fb) return err('Feedback not found');
  await nc.saveRow('Feedbacks', 'feedbackId', Object.assign({}, fb, { status: 'resolved' }));
  return { status: 'success', message: 'Marked resolved' };
}

/* ---------------- free courses ---------------- */
async function saveFreeCourse(p) {
  const row = p.row || {};
  if (!row.courseId) return err('Course select karna zaroori hai');
  const toSave = {
    freeCourseId: row.freeCourseId || uid('FC'), courseId: row.courseId,
    testIds: JSON.stringify(row.testIds || []), pyqIds: JSON.stringify(row.pyqIds || []),
    bookIds: JSON.stringify(row.bookIds || []), createdAt: row.createdAt || new Date().toISOString(),
  };
  await nc.saveRow('FreeCourses', 'freeCourseId', toSave);
  return ok({ freeCourseId: toSave.freeCourseId }, 'Free course saved');
}
async function getFreeCourses() {
  const [freeCourses, courses] = await Promise.all([nc.getAllRows('FreeCourses'), nc.getAllRows('Courses')]);
  const courseById = new Map(courses.map((c) => [c.courseId, c]));
  const data = freeCourses.map((fc) => {
    const c = courseById.get(fc.courseId);
    let testIds = [], pyqIds = [], bookIds = [];
    try { testIds = JSON.parse(fc.testIds || '[]'); } catch (e) {}
    try { pyqIds = JSON.parse(fc.pyqIds || '[]'); } catch (e) {}
    try { bookIds = JSON.parse(fc.bookIds || '[]'); } catch (e) {}
    return { freeCourseId: fc.freeCourseId, courseId: fc.courseId, courseName: c ? c.courseName : fc.courseId, courseImage: c ? c.courseImage : '', testIds, pyqIds, bookIds };
  });
  return { status: 'success', data };
}

/* ---------------- doubts (community board) ---------------- */
async function submitDoubt(p) {
  if (!p.userId || !String(p.message || '').trim()) return err('Doubt likhna zaroori hai.');
  await nc.appendRow('Doubts', { doubtId: uid('DBT'), userId: p.userId, name: p.name || '', message: p.message, createdAt: new Date().toISOString() });
  return { status: 'success', message: 'Doubt posted' };
}
async function submitDoubtReply(p) {
  if (!p.doubtId || !p.userId || !String(p.message || '').trim()) return err('Reply likhna zaroori hai.');
  await nc.appendRow('DoubtReplies', { replyId: uid('DR'), doubtId: p.doubtId, userId: p.userId, name: p.name || '', message: p.message, isCorrect: false, createdAt: new Date().toISOString() });
  return { status: 'success', message: 'Reply posted' };
}
async function markDoubtReplyCorrect(p) {
  const replies = await nc.getAllRows('DoubtReplies');
  const r = replies.find((x) => x.replyId === p.replyId);
  if (!r) return err('Reply not found');
  if (r.isCorrect === true || r.isCorrect === 'true') return err('Already marked correct');
  await nc.saveRow('DoubtReplies', 'replyId', Object.assign({}, r, { isCorrect: true }));
  await appendAttempt(r.userId, 'doubt', r.replyId, '', true, 1);
  return { status: 'success', message: 'Marked correct — +1 point awarded' };
}

/* ---------------- books (simplified access-controlled delivery) ---------------- */
async function studentCanAccessBook(userId, bookId) {
  const role = getUserRole(userId);
  if (role === 'admin' || role === 'mainadmin') return true;
  const studentBooks = await nc.getAllRows('StudentBooks');
  if (studentBooks.some((sb) => sb.studentUserId === userId && sb.bookId === bookId)) return true;
  const freeCourses = await nc.getAllRows('FreeCourses');
  return freeCourses.some((fc) => {
    let ids = [];
    try { ids = JSON.parse(fc.bookIds || '[]'); } catch (e) {}
    return ids.indexOf(bookId) !== -1;
  });
}
async function getBookFile(p) {
  if (!p.bookId || !p.userId) return err('Missing bookId/userId');
  const books = await nc.getAllRows('Books');
  const book = books.find((b) => b.bookId === p.bookId);
  if (!book) return err('Book not found');
  if (!(await studentCanAccessBook(p.userId, p.bookId))) return err('Aap is book ko padhne ke haqdar nahi hain.');
  // pdfUrl now points at our own /uploads (or any external host) file — served directly.
  return ok({ url: book.pdfUrl, bookName: book.bookName });
}

/* ---------------- file upload (free: local disk instead of Drive) ----
   Client sends base64 (no "data:...;base64," prefix) — same contract
   as the original uploadFile_. We save it under UPLOAD_DIR and hand
   back a public URL under PUBLIC_UPLOAD_BASE_URL, same shape as before.
   NOTE: on ephemeral hosts (free Render/Railway web services) this
   folder can be wiped on redeploy — see README for a persistent-disk
   or Cloudinary swap-in. */
async function uploadFile(p) {
  if (!p.base64 || !p.fileName) return err('No file received');
  try {
    fs.mkdirSync(uploads.dir, { recursive: true });
    const safeName = `${Date.now()}_${String(p.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploads.dir, safeName);
    fs.writeFileSync(filePath, Buffer.from(p.base64, 'base64'));
    const url = `${uploads.publicBaseUrl.replace(/\/+$/, '')}/${safeName}`;
    return ok({ url, fileId: safeName }, 'Uploaded');
  } catch (e) {
    return err('Upload failed: ' + e.message);
  }
}
async function logFileOpen(p) {
  if (!p.userId || !p.refId || !p.kind) return err('Missing data');
  if (await findAttemptByKey(`${p.userId}|${p.kind}|${p.refId}`)) return { status: 'success', message: 'Already logged' };
  await appendAttempt(p.userId, p.kind, p.refId, p.courseId || '', '', 0);
  return { status: 'success', message: 'Logged' };
}

const ROUTES = {
  linkDatabase: () => linkDatabase(),
  getTables: () => getTables(),
  sendOtp: (p) => sendOtp(p),
  verifyOtp: (p) => verifyOtp(p),
  registerAdmin: (p) => registerAdmin(p),
  adminLogin: (p) => adminLogin(p),
  login: (p) => login(p),
  studentRegister: (p) => studentRegister(p),
  resetPassword: (p) => resetPassword(p),
  getAllRows: (p) => getAllRowsAction(p),
  getManyTables: (p) => getManyTables(p.tables),

  saveCourse: (p) => saveGeneric('Courses', 'courseId', p.row),
  deleteCourse: (p) => deleteGeneric('Courses', 'courseId', p.id),
  saveSubject: (p) => saveGeneric('Subjects', 'subjectId', p.row),
  deleteSubject: (p) => deleteGeneric('Subjects', 'subjectId', p.id),
  saveTopic: (p) => saveGeneric('Topics', 'topicId', p.row),
  deleteTopic: (p) => deleteGeneric('Topics', 'topicId', p.id),
  saveLecture: (p) => saveLecture(p),
  deleteLecture: (p) => deleteGeneric('Lectures', 'lectureId', p.id),
  saveTest: (p) => saveGeneric('Tests', 'testId', p.row),
  deleteTest: (p) => deleteGeneric('Tests', 'testId', p.id),
  savePyq: (p) => saveGeneric('Pyqs', 'pyqId', p.row),
  deletePyq: (p) => deleteGeneric('Pyqs', 'pyqId', p.id),
  getQuizPapers: (p) => getQuizPapers(p),
  logPaperAttempt: (p) => logPaperAttempt(p),
  getPaperAttempts: (p) => getPaperAttempts(p),
  getStudents: () => getStudents(),
  assignBooks: (p) => assignBooks(p),
  deleteStudent: (p) => deleteGeneric('Students', 'userId', p.userId),
  blockStudent: (p) => blockStudent(p),

  savePaymentSettings: (p) => savePaymentSettings(p),
  getPaymentSettings: () => getPaymentSettings(),
  saveTransaction: (p) => saveTransaction(p),
  getPurchases: () => getPurchases(),
  verifyPurchase: (p) => verifyPurchase(p),

  submitFeedback: (p) => submitFeedback(p),
  getFeedbacks: async () => ({ status: 'success', data: await nc.getAllRows('Feedbacks') }),
  replyFeedback: (p) => replyFeedback(p),
  resolveFeedback: (p) => resolveFeedback(p),

  saveBook: (p) => saveGeneric('Books', 'bookId', p.row),
  deleteBook: (p) => deleteGeneric('Books', 'bookId', p.id),
  getBookFile: (p) => getBookFile(p),

  saveFreeCourse: (p) => saveFreeCourse(p),
  deleteFreeCourse: (p) => deleteGeneric('FreeCourses', 'freeCourseId', p.id),
  getFreeCourses: () => getFreeCourses(),

  submitDoubt: (p) => submitDoubt(p),
  submitDoubtReply: (p) => submitDoubtReply(p),
  markDoubtReplyCorrect: (p) => markDoubtReplyCorrect(p),

  uploadFile: (p) => uploadFile(p),
  logFileOpen: (p) => logFileOpen(p),

  logVideoWatch: (p) => logVideoWatch(p),
  submitAnswer: (p) => submitAnswer(p),
  getPerformance: (p) => getPerformance(p),
  backfillPerfSummary: () => backfillPerfSummary(),
};

async function route(body) {
  const handler = ROUTES[body.action];
  if (!handler) return err('Unknown action: ' + body.action);
  return handler(body);
}

module.exports = { route };
