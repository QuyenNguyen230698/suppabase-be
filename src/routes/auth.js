import { Router } from 'express';
import { login, refresh, logout, sendOtp, verifyOtp } from '../controllers/authController.js';
import { validate } from '../middleware/validate.js';
import { sendOtpBody, verifyOtpBody } from '../schemas/auth.js';

const router = Router();

router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);

// Email OTP login
router.post('/send-otp', validate({ body: sendOtpBody }), sendOtp);
router.post('/verify-otp', validate({ body: verifyOtpBody }), verifyOtp);

export default router;
