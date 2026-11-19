import { migrate } from './migrate.js';

const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error('ADMIN_DATABASE_URL is required (the schema owner connection)');
  process.exit(1);
}
await migrate(url);
console.log('migrations up to date');
