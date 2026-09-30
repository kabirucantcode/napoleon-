import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env before anything constructs a client (__dirname is dist/ at runtime).
// Deliberately the only place env is read at startup: no module in this app
// reads process.env at import time, so decorator evaluation cannot race dotenv.
config({ path: resolve(__dirname, '..', '.env'), override: true });

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const DEFAULT_PORT = 3010;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  app.setGlobalPrefix('api/v1');

  // Server-to-server callers never preflight, so CORS only matters for a
  // browser client. Empty CORS_ORIGIN therefore means "no browser clients",
  // not "broken".
  const origins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({ origin: origins, credentials: false });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  new Logger('Bootstrap').log(
    `Napoleon listening on :${port}/api/v1${
      origins.length ? ` (browser origins: ${origins.join(', ')})` : ''
    }`,
  );
}

bootstrap();
