import { Module } from '@nestjs/common';
import { AccessModule } from '../auth/access.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  imports: [AccessModule],
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}
