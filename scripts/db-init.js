const { bootstrapDatabase } = require('../src/db');

bootstrapDatabase()
  .then(() => {
    console.log('Database initialized');
    process.exit(0);
  })
  .catch((e) => {
    console.error('DB init failed', e);
    process.exit(1);
  });

