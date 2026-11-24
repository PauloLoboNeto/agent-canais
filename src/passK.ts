/**
 * pass^k do τ-bench: a chance de o agente acertar a MESMA tarefa em todas as k tentativas.
 * Com n tentativas e c sucessos, o estimador sem viés é C(c, k) / C(n, k).
 *
 * A média (pass^1) diz quão bom o agente é; o pass^k diz quão confiável ele é. Num canal
 * com milhares de conversas por dia, é o segundo número que importa.
 */
export function passHatK(n: number, c: number, k: number): number {
  if (k < 1 || k > n) throw new Error(`k deve estar entre 1 e n (k=${k}, n=${n})`);
  if (c < 0 || c > n) throw new Error(`c deve estar entre 0 e n (c=${c}, n=${n})`);
  if (c < k) return 0;
  return combinacoes(c, k) / combinacoes(n, k);
}

function combinacoes(n: number, k: number): number {
  let resultado = 1;
  for (let i = 1; i <= k; i++) resultado = (resultado * (n - k + i)) / i;
  return resultado;
}
