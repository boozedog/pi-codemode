declare module "ajv" {
  interface AjvOptions {
    allErrors?: boolean;
    strict?: boolean | "log";
  }
  interface ValidationError {
    instancePath: string;
    keyword: string;
    params: Record<string, unknown>;
    message?: string;
  }
  interface ValidateFunction {
    (data: unknown): boolean;
    errors?: ValidationError[] | null;
  }
  export default class Ajv {
    constructor(options?: AjvOptions);
    compile(schema: unknown): ValidateFunction;
  }
}
