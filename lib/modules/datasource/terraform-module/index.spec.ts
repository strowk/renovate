import { getPkgReleases } from '..';
import * as httpMock from '../../../../test/http-mock';
import { loadFixture } from '../../../../test/util';
import { TerraformModuleDatasource } from '.';

const consulData: any = loadFixture('registry-consul.json');
const serviceDiscoveryResult: any = loadFixture('service-discovery.json');
const serviceDiscoveryCustomResult: any = loadFixture(
  'service-custom-discovery.json'
);

const datasource = TerraformModuleDatasource.id;
const baseUrl = 'https://registry.terraform.io';
const localTerraformEnterprisebaseUrl = 'https://terraform.foo.bar';

describe('modules/datasource/terraform-module/index', () => {
  describe('getReleases', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns null for empty result', async () => {
      httpMock
        .scope(baseUrl)
        .get('/v1/modules/hashicorp/consul/aws')
        .reply(200, {})
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryResult);
      expect(
        await getPkgReleases({
          datasource,
          depName: 'hashicorp/consul/aws',
        })
      ).toBeNull();
    });

    it('returns null for 404', async () => {
      httpMock
        .scope(baseUrl)
        .get('/v1/modules/hashicorp/consul/aws')
        .reply(404, {})
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryResult);
      expect(
        await getPkgReleases({
          datasource,
          depName: 'hashicorp/consul/aws',
        })
      ).toBeNull();
    });

    it('returns null for unknown error', async () => {
      httpMock
        .scope(baseUrl)
        .get('/v1/modules/hashicorp/consul/aws')
        .replyWithError('')
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryResult);
      expect(
        await getPkgReleases({
          datasource,
          depName: 'hashicorp/consul/aws',
        })
      ).toBeNull();
    });

    it('processes real data', async () => {
      httpMock
        .scope(baseUrl)
        .get('/v1/modules/hashicorp/consul/aws')
        .reply(200, consulData)
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryResult);
      const res = await getPkgReleases({
        datasource,
        depName: 'hashicorp/consul/aws',
      });
      expect(res).toMatchSnapshot();
      expect(res).not.toBeNull();
    });

    it('processes with registry in name', async () => {
      httpMock
        .scope(baseUrl)
        .get('/v1/modules/hashicorp/consul/aws')
        .reply(200, consulData)
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryResult);
      const res = await getPkgReleases({
        datasource,
        depName: 'registry.terraform.io/hashicorp/consul/aws',
      });
      expect(res).toMatchSnapshot();
      expect(res).not.toBeNull();
    });

    it('rejects mismatch', async () => {
      httpMock
        .scope('https://terraform.company.com')
        .get('/v1/modules/consul/foo')
        .reply(200, consulData)
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryResult);
      const res = await getPkgReleases({
        datasource,
        depName: 'consul/foo',
        registryUrls: ['https://terraform.company.com'],
      });
      expect(res).toBeNull();
    });

    it('rejects servicediscovery', async () => {
      httpMock
        .scope('https://terraform.company.com')
        .get('/.well-known/terraform.json')
        .reply(404);
      const res = await getPkgReleases({
        datasource,
        depName: 'consul/foo',
        registryUrls: ['https://terraform.company.com'],
      });
      expect(res).toBeNull();
    });

    it('processes real data on changed subpath', async () => {
      httpMock
        .scope(localTerraformEnterprisebaseUrl)
        .get('/api/registry/v1/modules/hashicorp/consul/aws')
        .reply(200, consulData)
        .get('/.well-known/terraform.json')
        .reply(200, serviceDiscoveryCustomResult);
      const res = await getPkgReleases({
        datasource,
        registryUrls: ['https://terraform.foo.bar'],
        depName: 'hashicorp/consul/aws',
      });

      expect(res).toMatchSnapshot();
      expect(res).not.toBeNull();
    });
  });
});
