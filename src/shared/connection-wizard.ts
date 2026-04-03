import { window, Disposable, QuickInput, QuickInputButtons, QuickPickItem } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { logger } from "../logger/logger";

type ConnectionType = "network" | "embedded" | "docker";

export async function connectionWizard() {
  const title = "FIREBIRD: Add New Connection";

  async function collectInputs(): Promise<ConnectionOptions> {
    logger.info("Connection wizard start...");

    const options = {} as Partial<ConnectionOptions>;
    await MultiStepInput.run(input => connectionType(input, options));
    return options as ConnectionOptions;
  }

  async function connectionType(input: MultiStepInput, options: Partial<ConnectionOptions>) {
    const items: QuickPickItem[] = [
      { label: "$(server) Network", description: "Connect to a Firebird server via TCP/IP" },
      { label: "$(file-directory) Embedded", description: "Connect to a local embedded Firebird database file" },
      { label: "$(container) Docker", description: "Connect to a Firebird server running in Docker (localhost:3050)" }
    ];

    const picked = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 7,
      items,
      placeholder: "Select connection type",
      ignoreFocusOut: true
    });

    if (!picked) {
      return Promise.reject("Connection type not selected. Add Connection canceled.");
    }

    const type: ConnectionType = picked.label.includes("Embedded")
      ? "embedded"
      : picked.label.includes("Docker")
      ? "docker"
      : "network";

    options.embedded = type === "embedded";

    if (type === "embedded") {
      options.host = "";
      options.port = null;
      return (input: MultiStepInput) => database(input, options, 2, 5);
    } else if (type === "docker") {
      options.host = "localhost";
      options.port = 3050;
      return (input: MultiStepInput) => database(input, options, 2, 6);
    } else {
      return (input: MultiStepInput) => host(input, options);
    }
  }

  async function host(input: MultiStepInput, options: Partial<ConnectionOptions>) {
    options.host = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 7,
      prompt: "[REQUIRED] The hostname of the database.",
      placeHolder: "e.g. 'localhost'",
      ignoreFocusOut: true
    });
    if (!options.host) {
      return Promise.reject("Hostname cannot be empty. Add Connection canceled.");
    } else {
      return (input: MultiStepInput) => database(input, options, 3, 7);
    }
  }

  async function database(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const prompt = options.embedded
      ? "[REQUIRED] Absolute path to the local Firebird database file."
      : "[REQUIRED] Absolute path to Firebird database on the server.";

    options.database = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt,
      placeHolder: "e.g. '/var/db/mydb.fdb'",
      ignoreFocusOut: true
    });
    if (!options.database) {
      return Promise.reject("Database cannot be empty. Add Connection canceled.");
    } else if (options.embedded) {
      return (input: MultiStepInput) => user(input, options, step + 1, totalSteps);
    } else {
      return (input: MultiStepInput) => port(input, options, step + 1, totalSteps);
    }
  }

  async function port(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const portInput = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] Port number. Leave empty for default.",
      placeHolder: "defaults to 3050",
      ignoreFocusOut: true
    });
    if (!portInput) {
      logger.info("Default port 3050 selected.");
      options.port = 3050;
    } else {
      options.port = Number.parseInt(portInput) || 3050;
    }
    return (input: MultiStepInput) => user(input, options, step + 1, totalSteps);
  }

  async function user(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    options.user = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] Firebird user to authenticate as. Leave empty for default.",
      placeHolder: "defaults to SYSDBA",
      ignoreFocusOut: true
    });
    if (!options.user) {
      logger.info("Default user sysdba selected.");
      options.user = "sysdba";
    }
    return (input: MultiStepInput) => password(input, options, step + 1, totalSteps);
  }

  async function password(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    options.password = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] The password of the Firebird user. Leave empty for default.",
      placeHolder: "defaults to masterkey",
      ignoreFocusOut: true,
      password: true
    });

    if (!options.password) {
      logger.info("Default password masterkey selected.");
      options.password = "masterkey";
    }
    return (input: MultiStepInput) => role(input, options, step + 1, totalSteps);
  }

  async function role(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    options.role = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] User Role. Leave empty for default.",
      placeHolder: "Defaults to null",
      ignoreFocusOut: true
    });

    if (!options.role) {
      logger.info("Default user role selected.");
      options.role = null;
    }

    if (!options.embedded) {
      return (input: MultiStepInput) => wireCrypt(input, options, step + 1, totalSteps);
    }
  }

  async function wireCrypt(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const items: QuickPickItem[] = [
      { label: "Enabled", description: "Use wire encryption when available (default)" },
      { label: "Required", description: "Always require wire encryption (Firebird 4.x/5.x)" },
      { label: "Disabled", description: "Disable wire encryption" }
    ];

    const picked = await input.showQuickPick({
      title,
      step,
      totalSteps,
      items,
      placeholder: "[OPTIONAL] Wire encryption — Firebird 4.x/5.x (leave as Enabled for older versions)",
      ignoreFocusOut: true
    });

    if (picked && picked.label !== "Enabled") {
      options.wireCrypt = picked.label as ConnectionOptions["wireCrypt"];
    }
    // Enabled is the default so we don't need to store it explicitly
  }

  return await collectInputs();
}

class InputFlowAction {
  static back = new InputFlowAction();
  static cancel = new InputFlowAction();
}

type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface InputBoxParameters {
  title: string;
  step: number;
  totalSteps: number;
  prompt: string;
  placeHolder: string;
  ignoreFocusOut: boolean;
  password?: boolean;
}

interface QuickPickParameters {
  title: string;
  step: number;
  totalSteps: number;
  items: QuickPickItem[];
  placeholder: string;
  ignoreFocusOut: boolean;
}

class MultiStepInput {
  static async run(start: InputStep) {
    const input = new MultiStepInput();
    return input.stepThrough(start);
  }

  private current?: QuickInput;
  private steps: InputStep[] = [];

  private async stepThrough(start: InputStep) {
    let step: InputStep | void = start;
    while (step) {
      this.steps.push(step);
      try {
        step = await step(this);
      } catch (err) {
        if (err === InputFlowAction.back) {
          this.steps.pop();
          step = this.steps.pop();
        } else if (err === InputFlowAction.cancel) {
          step = undefined;
        } else {
          this.current.dispose();
          throw err;
        }
      }
    }
    if (this.current) {
      this.current.dispose();
    }
  }

  async showQuickPick<P extends QuickPickParameters>({
    title,
    step,
    totalSteps,
    items,
    placeholder,
    ignoreFocusOut
  }: P): Promise<QuickPickItem | undefined> {
    const disposables: Disposable[] = [];
    try {
      return await new Promise<QuickPickItem | undefined>((resolve, reject) => {
        const pick = window.createQuickPick<QuickPickItem>();
        pick.title = title;
        pick.step = step;
        pick.totalSteps = totalSteps;
        pick.items = items;
        pick.placeholder = placeholder;
        pick.ignoreFocusOut = ignoreFocusOut;
        pick.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : [])];
        disposables.push(
          pick.onDidTriggerButton(button => {
            if (button === QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(undefined);
            }
          }),
          pick.onDidAccept(() => {
            resolve(pick.selectedItems[0]);
          }),
          pick.onDidHide(() => {
            resolve(undefined);
          })
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = pick;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }

  async showInputBox<P extends InputBoxParameters>({
    title,
    step,
    totalSteps,
    prompt,
    placeHolder,
    ignoreFocusOut,
    password
  }: P) {
    const disposables: Disposable[] = [];
    try {
      return await new Promise<string | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
        const input = window.createInputBox();
        input.title = title;
        input.step = step;
        input.totalSteps = totalSteps;
        input.prompt = prompt;
        input.placeholder = placeHolder;
        input.ignoreFocusOut = ignoreFocusOut;
        input.password = password || false;
        input.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : [])];
        disposables.push(
          input.onDidTriggerButton(button => {
            if (button === QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(<any>button);
            }
          }),
          input.onDidAccept(async () => {
            const value = input.value;
            resolve(value);
          })
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }
}
