import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('ready', () => {
    it('reports the database as connected on a successful ping', async () => {
      const result = await controller.ready();

      expect(result.database.connected).toBe(true);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns a non-negative responseTime derived from the measured query duration', async () => {
      const result = await controller.ready();

      expect(typeof result.database.responseTime).toBe('number');
      expect(result.database.responseTime).toBeGreaterThanOrEqual(0);
    });

    it('reflects the actual query duration rather than a hardcoded constant', async () => {
      const delayMs = 25;
      prisma.$queryRaw.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([{ '?column?': 1 }]), delayMs)),
      );

      const result = await controller.ready();

      expect(result.database.responseTime).toBeGreaterThanOrEqual(delayMs);
    });

    it('does not include responseTime in the failure path', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      const result = await controller.ready();

      expect(result.database.connected).toBe(false);
      expect(result.database).not.toHaveProperty('responseTime');
    });
  });
});
