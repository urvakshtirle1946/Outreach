import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const envPaths = [
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '..', '.env')
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}
