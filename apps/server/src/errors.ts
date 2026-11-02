import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { logger } from './infrastructure';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }
    // Driver errors can embed connection strings, SQL values, or credentials.
    logger.error({ code: 'UNEXPECTED_API_ERROR' }, 'API request failed');
    response.status(500).json({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  }
}
