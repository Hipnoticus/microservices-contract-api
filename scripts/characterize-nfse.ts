/**
 * Characterization fixtures for the move of NFS-e to NFeAPI (SRP phase 3, 2026-11-20). Runs ContractAPI's own
 * NFSeNacionalService with a frozen clock and a fake fetch, and writes the DPS payload (what would be sent to the
 * NFS-e Nacional), the request it would make and what the controller would store, so NFeAPI's xUnit tests can assert
 * byte-identical output. Nothing is sent anywhere: fetch is replaced and no certificate is loaded.
 *
 *   TZ=America/Sao_Paulo bun run scripts/characterize-nfse.ts ../NFeAPI/tests/NFeAPI.Tests/Fixtures/contractapi-nfse.json
 */
import { writeFileSync } from 'node:fs';
import { NFSeNacionalService, NFSeConfig, DPSData } from '../src/infrastructure/nfse/NFSeNacionalService';

const RealDate = Date;
function freeze(iso: string) {
  const fixed = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [any]));
    }
    static now() { return fixed; }
  }
  (globalThis as any).Date = FrozenDate;
}

function config(environment: 'homologacao' | 'producao'): NFSeConfig {
  return {
    cnpj: '12344385000193', inscricaoMunicipal: '', razaoSocial: 'HIPNOTICUS TERAPIA LTDA', nomeFantasia: 'Hipnoticus',
    codigoMunicipio: '5300108', uf: 'DF', serviceCode: '8690-9/99', serviceDescription: 'Serviços de hipnoterapia clínica',
    issRate: 5, environment, certPath: '', certPassword: '',
  };
}

const base: DPSData = {
  prestadorCnpj: '12344385000193', prestadorIM: '', tomadorCpfCnpj: '10962509779', tomadorNome: 'Gabriel Veloso',
  tomadorEmail: 'punkore8@gmail.com', codigoServico: '8690-9/99', descricaoServico: 'Serviços de hipnoterapia clínica',
  valorServico: 150, aliquotaISS: 5, codigoMunicipio: '5300108',
};

const cases: { name: string; now: string; environment: 'homologacao' | 'producao'; data: DPSData }[] = [
  { name: 'cpf-homologacao', now: '2026-11-20T11:19:27.380Z', environment: 'homologacao', data: base },
  { name: 'cpf-producao', now: '2026-11-20T11:19:27.380Z', environment: 'producao', data: base },
  { name: 'no-email-decimal', now: '2026-03-05T14:00:00.001Z', environment: 'homologacao',
    data: { ...base, tomadorEmail: undefined, valorServico: 99.9, aliquotaISS: 5 } },
  { name: 'cnpj-tomador', now: '2026-07-31T23:59:59.999Z', environment: 'homologacao',
    data: { ...base, tomadorCpfCnpj: '12.344.385/0001-93', tomadorNome: 'Empresa & Cia <Ltda>', valorServico: 1234.56, aliquotaISS: 2.5 } },
  // 14 characters with punctuation: ContractAPI decides CPF/CNPJ on the raw length, so a formatted CPF goes out as CNPJ
  { name: 'formatted-cpf', now: '2026-01-01T02:00:00.000Z', environment: 'homologacao',
    data: { ...base, tomadorCpfCnpj: '109.625.097-79', valorServico: 0.1, aliquotaISS: 2, tomadorEmail: '' } },
  { name: 'month-boundary-brt', now: '2026-12-01T01:30:00.000Z', environment: 'producao',
    data: { ...base, codigoServico: '04.01.01', descricaoServico: 'Sessão "online"\nlinha 2', valorServico: 1, aliquotaISS: 5 } },
  { name: 'empty-tomador', now: '2026-05-10T12:00:00.000Z', environment: 'homologacao',
    data: { ...base, tomadorCpfCnpj: '', tomadorNome: 'null null', valorServico: 10, aliquotaISS: 5 } },
];

type Reply = { kind: 'json'; status: number; body: any } | { kind: 'text'; status: number; body: string } | { kind: 'throw'; message: string };
const replies: { name: string; reply: Reply }[] = [
  { name: 'created', reply: { kind: 'json', status: 201, body: { chNFSe: '53001082212344385000193000000000000126110000000001', numero: '12', nProt: 'P-1' } } },
  { name: 'ok-alt-fields', reply: { kind: 'json', status: 200, body: { nNFSe: '13', protocolo: 'P-2' } } },
  { name: 'rejected-mensagem', reply: { kind: 'json', status: 400, body: { mensagem: 'Rejeição: CNPJ inválido', codigo: 'E001' } } },
  { name: 'rejected-message', reply: { kind: 'json', status: 422, body: { message: 'bad' } } },
  { name: 'rejected-other', reply: { kind: 'json', status: 500, body: { erros: [{ codigo: 'X', descricao: 'ç' }] } } },
  { name: 'not-json', reply: { kind: 'text', status: 503, body: '<html>down</html>' } },
  { name: 'network-error', reply: { kind: 'throw', message: 'connect ECONNREFUSED 10.0.0.1:443' } },
];

async function run() {
  const dps: any[] = [];
  for (const c of cases) {
    freeze(c.now);
    const svc: any = new NFSeNacionalService(config(c.environment));
    const payload = svc.buildDPS(c.data);
    dps.push({ name: c.name, now: c.now, environment: c.environment, data: c.data, json: JSON.stringify(payload) });
  }
  const emissions: any[] = [];
  for (const environment of ['homologacao', 'producao'] as const) {
    for (const r of replies) {
      freeze('2026-11-20T11:19:27.380Z');
      const svc: any = new NFSeNacionalService(config(environment));
      svc.httpsAgent = {}; // pretend the certificate loaded; the fake fetch below is what answers
      const sent: any[] = [];
      (globalThis as any).fetch = async (url: string, init: any) => {
        sent.push({ url, method: init.method, headers: init.headers, body: init.body });
        if (r.reply.kind === 'throw') throw new Error(r.reply.message);
        const reply = r.reply;
        return {
          status: reply.status,
          json: async () => (reply.kind === 'json' ? reply.body : JSON.parse(reply.body)),
        } as any;
      };
      const result = await svc.emitirDPS(base);
      emissions.push({ name: `${environment}-${r.name}`, environment, reply: r.reply, sent, result });
    }
  }
  return { generatedBy: 'ContractAPI scripts/characterize-nfse.ts', tz: process.env.TZ ?? '', dps, emissions };
}

run().then((out) => {
  const file = process.argv[2] || 'contractapi-nfse.json';
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${file}: ${out.dps.length} DPS, ${out.emissions.length} emissions`);
});
