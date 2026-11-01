import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { port, required } from './config';
import { logger } from './infrastructure';

async function bootstrap() {
  required('DATABASE_URL');
  required('REDIS_URL');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Pedirr API').setDescription('Sports content requests and moderation')
    .setVersion('1.0').addCookieAuth('pedirr_session').build());
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
  await app.listen(port(), '0.0.0.0');
  logger.info({ port: port() }, 'Pedirr API listening');
}
bootstrap().catch((error: unknown) => { logger.fatal({ err: error }, 'Startup failed'); process.exitCode = 1; });
