import { completeOpenApi } from './openapi';
import 'reflect-metadata';
import { static as staticFiles, Request, Response, NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { port, required } from './config';
import { logger } from './infrastructure';

async function bootstrap() {
  required('DATABASE_URL');
  required('REDIS_URL');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'https:', 'http:'], upgradeInsecureRequests: null } } }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Pedirr API').setDescription('Sports content requests and moderation')
    .setVersion('1.0').build());
  completeOpenApi(document, required('APP_ORIGIN'));
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
  const webRoot = resolve(__dirname, '../../web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.use(staticFiles(webRoot, { index: false }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && req.accepts('html')) {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(resolve(webRoot, 'index.html'));
      } else next();
    });
  }
  await app.listen(port(), '0.0.0.0');
  logger.info({ port: port() }, 'Pedirr API listening');
}
bootstrap().catch((error: unknown) => { logger.fatal({ err: error }, 'Startup failed'); process.exitCode = 1; });
