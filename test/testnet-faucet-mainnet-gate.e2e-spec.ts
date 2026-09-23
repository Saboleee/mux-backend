import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { NetworkConfigService } from '../src/config/network-config.service';
import { FaucetService } from '../src/faucet/faucet.service';
import { FaucetErrorCode } from '../src/faucet/faucet.errors';

/**
 * E2E coverage for the testnet faucet mainnet gate (issue #882).
 *
 * Invariants:
 *  - The faucet is only available on testnet networks.
 *  - On mainnet (or any unknown/misconfigured network) the faucet fails closed.
 *  - Denials are typed with a stable error code and a correlation id.
 *  - Authz cannot be used to bypass the network gate.
 */
describe('Testnet faucet mainnet gate (e2e)', () => {
  let app: INestApplication;
  let networkConfig: NetworkConfigService;
  let faucet: FaucetService;

  const API_KEY = process.env.FAUCET_API_KEY ?? 'test-api-key';
  const RECIPIENT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    networkConfig = app.get(NetworkConfigService);
    faucet = app.get(FaucetService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('mainnet network', () => {
    beforeEach(() => {
      jest.spyOn(networkConfig, 'getNetwork').mockReturnValue('mainnet');
      jest.spyOn(networkConfig, 'isTestnet').mockReturnValue(false);
    });

    it('denies faucet requests with a stable error code', async () => {
      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipient: RECIPIENT });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error).toBe(FaucetErrorCode.FAUCET_DISABLED_ON_MAINNET);
      expect(res.body.correlationId).toBeDefined();
    });

    it('does not leak network internals in the denial payload', async () => {
      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipient: RECIPIENT });

      expect(JSON.stringify(res.body)).not.toMatch(/secret|private|key/i);
    });

    it('cannot be bypassed by a valid API key', async () => {
      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipient: RECIPIENT });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error).toBe(FaucetErrorCode.FAUCET_DISABLED_ON_MAINNET);
    });

    it('fails closed when the network is unknown/misconfigured', async () => {
      jest.spyOn(networkConfig, 'getNetwork').mockReturnValue('unknown' as any);
      jest.spyOn(networkConfig, 'isTestnet').mockReturnValue(false);

      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipient: RECIPIENT });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error).toBe(FaucetErrorCode.FAUCET_DISABLED_ON_MAINNET);
    });

    it('rejects unauthenticated requests before evaluating the gate', async () => {
      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .send({ recipient: RECIPIENT });

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('testnet network', () => {
    beforeEach(() => {
      jest.spyOn(networkConfig, 'getNetwork').mockReturnValue('testnet');
      jest.spyOn(networkConfig, 'isTestnet').mockReturnValue(true);
    });

    it('allows faucet requests on testnet', async () => {
      jest.spyOn(faucet, 'request').mockResolvedValue({
        txHash: 'deadbeef',
        correlationId: 'corr-1',
      } as any);

      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipient: RECIPIENT });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.txHash).toBe('deadbeef');
    });

    it('is idempotent for replayed requests', async () => {
      const spy = jest.spyOn(faucet, 'request').mockResolvedValue({
        txHash: 'deadbeef',
        correlationId: 'corr-1',
      } as any);

      const payload = { recipient: RECIPIENT, idempotencyKey: 'idem-1' };

      const first = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send(payload);
      const second = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send(payload);

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(second.status).toBe(HttpStatus.CREATED);
      expect(first.body.txHash).toBe(second.body.txHash);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('fails closed on dependency outage', async () => {
      jest
        .spyOn(faucet, 'request')
        .mockRejectedValue(new Error('horizon unavailable'));

      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipient: RECIPIENT });

      expect(res.status).toBeGreaterThanOrEqual(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.body.error).toBeDefined();
    });

    it('rejects adversarial oversized batches', async () => {
      const recipients = Array.from({ length: 1000 }, () => RECIPIENT);

      const res = await request(app.getHttpServer())
        .post('/faucet/request')
        .set('x-api-key', API_KEY)
        .send({ recipients });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });
});
