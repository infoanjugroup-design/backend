const nodemailer = require('nodemailer');
const { email } = require('./config');

let transporter = null;
function getTransporter() {
  if (!email.user || !email.pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: email.user, pass: email.pass },
    });
  }
  return transporter;
}

// purpose-specific templates — never reuse one template for a
// different purpose, so an OTP email never reads like a bill or a
// generic notice.
const TEMPLATES = {
  login: (otp) => ({ subject: 'GATE99 — Your login OTP', body: `Your OTP to log in to GATE99 is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.` }),
  studentRegister: (otp) => ({ subject: 'GATE99 — Verify your registration', body: `Your OTP to complete registration on GATE99 is: ${otp}\n\nThis code expires in 10 minutes.` }),
  adminLogin: (otp) => ({ subject: 'GATE99 Staff — Your login OTP', body: `Your OTP to log in to the GATE99 Admin Panel is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.` }),
  forgotPassword: (otp) => ({ subject: 'GATE99 Staff — Reset your password', body: `Your OTP to reset your GATE99 Admin Panel password is: ${otp}\n\nIf you did not request this, ignore this email.` }),
};

function emailTemplate(purpose, otp) {
  const fn = TEMPLATES[purpose];
  return fn ? fn(otp) : { subject: 'GATE99 — OTP', body: `Your OTP is: ${otp}` };
}

async function sendOtpEmail(to, purpose, otp) {
  const t = getTransporter();
  if (!t) throw new Error('Email is not configured — set EMAIL_USER/EMAIL_PASS in .env (see README).');
  const tpl = emailTemplate(purpose, otp);
  await t.sendMail({ from: `"${email.fromName}" <${email.user}>`, to, subject: tpl.subject, text: tpl.body });
}

async function sendPlainEmail(to, subject, body) {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.sendMail({ from: `"${email.fromName}" <${email.user}>`, to, subject, text: body });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { sendOtpEmail, sendPlainEmail };
