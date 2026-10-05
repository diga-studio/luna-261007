import type { SendOutcome, SendRequest, Simulator } from '../src/index.ts';

export interface PendingCall {
  req: SendRequest;
  resolve: (outcome: SendOutcome) => void;
  settled: boolean;
}

export class ControlledSimulator {
  readonly calls: PendingCall[] = [];

  readonly simulator: Simulator = (req) => {
    let resolveFn: (outcome: SendOutcome) => void = () => {};
    const promise = new Promise<SendOutcome>((resolve) => {
      resolveFn = resolve;
    });
    const call: PendingCall = {
      req,
      settled: false,
      resolve: (outcome) => {
        if (call.settled) throw new Error('call already settled');
        call.settled = true;
        resolveFn(outcome);
      },
    };
    this.calls.push(call);
    return promise;
  };

  pending(): PendingCall[] {
    return this.calls.filter((c) => !c.settled);
  }

  settle(index: number, outcome: SendOutcome): void {
    this.calls[index].resolve(outcome);
  }
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
