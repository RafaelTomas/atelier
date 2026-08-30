/**
 * Reserva de spawn por nó: uma chave, uma abertura em voo.
 *
 * Existe porque a guarda antiga do `TerminalManager` lia o mapa de sessões e só
 * escrevia nele TRÊS `await` depois. Entre a leitura e a escrita cabia uma
 * segunda chamada inteira — e o `<StrictMode>` do renderer entrega exatamente
 * isso, duas vezes, em dev. O resultado eram dois PTYs no mesmo nó, dois ids de
 * sessão gerados, e o `session.json` ficando com o do agente que não subiu.
 *
 * A reserva é feita ANTES de qualquer `await`: entre o `get` e o `set` deste
 * mapa não existe ponto de suspensão, e é só por isso que ela segura. Quem
 * chega depois recebe a MESMA promessa, e não um segundo processo.
 *
 * Módulo puro — sem `node-pty`, sem `electron`, sem disco. É o que o teste
 * exercita (scripts/test-spawn-reentrante.mjs).
 */
export class SpawnRegistry<T> {
  private inFlight = new Map<string, Promise<T>>()

  /**
   * Roda `factory` para esta chave, ou devolve a execução que já está em voo.
   *
   * O registro é limpo assim que a promessa assenta — inclusive quando ela
   * REJEITA. Uma falha que deixasse a chave presa trancaria o nó para sempre:
   * nenhuma tentativa seguinte chegaria à fábrica.
   */
  run(key: string, factory: () => Promise<T>): Promise<T> {
    const pendente = this.inFlight.get(key)
    if (pendente) return pendente

    let started: Promise<T>
    try {
      started = factory()
    } catch (err) {
      // Fábrica que lança de forma síncrona nunca chegou a reservar nada.
      return Promise.reject(err)
    }
    const tracked = started.finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, tracked)
    return tracked
  }

  /** A execução em voo desta chave, quando há uma. */
  pending(key: string): Promise<T> | undefined {
    return this.inFlight.get(key)
  }

  get size(): number {
    return this.inFlight.size
  }
}
