const bcrypt = require('bcryptjs');
const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.log('วิธีใช้: node create_admin_account.js <email> <password>');
  process.exit(1);
}
bcrypt.hash(password, 10).then((hash) => {
  console.log('\n✅ เอา SQL นี้ไปรันใน phpMyAdmin:\n');
  console.log(`INSERT INTO users (email, password, user_type) VALUES ('${email}', '${hash}', 'admin');\n`);
});
