// Hardcoded users. To add/change passwords, generate a new hash:
// cd suppabase-be && node --input-type=module -e "import bcrypt from 'bcrypt'; console.log(await bcrypt.hash('yourpassword', 10));"
export const USERS = [
  {
    id: 'u1',
    username: 'admin-suppabase',
    // password: Quyen@2019
    passwordHash: '$2b$10$KeUZz6Hpi7RYJRsN7f01Ee2Hghq76zfYgvKVLRq3ilkFDtwYthc5K',
    role: 'admin',
  },
];
