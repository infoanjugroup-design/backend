/* Same table/column layout as the original Google-Sheets backend
   (Code.gs → TABLES). Every table is auto-created in NocoDB on first
   boot with these exact column names. All columns are created as
   plain text — matching the original Sheets behaviour where every
   cell was loosely-typed text/number/boolean read back with Number()/
   Boolean coercion at the app layer — so nothing here needs NocoDB-
   specific column types to work correctly. */

const TABLES = {
  Admins:      ['email','name','passwordHash','salt','isMainAdmin','createdAt'],
  Students:    ['userId','name','email','mobile','passwordHash','salt','blocked','createdAt'],
  Courses:     ['courseId','courseName','fees','courseImage','createdAt'],
  Subjects:    ['subjectId','courseId','subjectName'],
  Topics:      ['topicId','subjectId','topicName'],
  Lectures:    ['lectureId','topicId','subjectId','courseId','videoId','title','embedCode'],
  Tests:       ['testId','topicId','question','optionA','optionB','optionC','optionD','correct','testName','testType','isFile','fileUrl','fileName','fileMime','fileSize','answerKey','contentEnc'],
  Pyqs:        ['pyqId','topicId','year','question','optionA','optionB','optionC','optionD','correct','pyqName','pyqType','isFile','fileUrl','fileName','fileMime','fileSize','answerKey','contentEnc'],
  Books:       ['bookId','bookName','courseId','pdfUrl','bookImage'],
  StudentBooks:['studentUserId','bookId'],
  Enrollments: ['userId','courseId','purchasedAt'],
  OTPs:        ['email','otp','purpose','expiresAt'],
  AdminLogs:   ['timestamp','event','email'],
  Purchases:   ['purchaseId','userId','courseId','transactionId','paymentMethod','amount','status','billNo','createdAt','verifiedAt'],
  Bills:       ['billId','userId','courseId','billNo','amount','issuedAt'],
  Feedbacks:   ['feedbackId','userId','name','email','message','attachmentUrl','status','reply','repliedAt','createdAt'],
  PaymentSettings: ['id','accountNo','ifsc','upiId','qrUrl','signatureUrl','updatedAt'],
  FreeCourses: ['freeCourseId','courseId','testIds','pyqIds','bookIds','createdAt'],
  Doubts:       ['doubtId','userId','name','message','createdAt'],
  DoubtReplies: ['replyId','doubtId','userId','name','message','isCorrect','createdAt'],
  Attempts:     ['attemptId','userId','kind','refId','courseId','correct','points','createdAt','attemptKey'],
  PerfSummary:  ['userId','totalPoints','videoCount','correctCount','wrongCount','doubtPoints','attemptCount'],
};

// Fields that must NEVER leave the server through the generic
// getAllRows action for Tests/Pyqs.
const PAPER_SECRET_FIELDS = ['correct', 'answerKey', 'contentEnc', 'fileUrl'];

module.exports = { TABLES, PAPER_SECRET_FIELDS };
