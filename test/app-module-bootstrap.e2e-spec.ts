import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { HealthModule } from '../src/health/health.module';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AppModule bootstrap (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots the application', () => {
    expect(app).toBeDefined();
  });
});

describe('HealthModule (isolated)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('resolves HealthController without DI errors', () => {
    const controller = moduleRef.get(HealthController);
    expect(controller).toBeDefined();
  });

  it('injects PrismaService into HealthController', () => {
    const controller = moduleRef.get(HealthController);
    expect(controller.prisma).toBeInstanceOf(PrismaService);
  });
});
