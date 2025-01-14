import { Context } from "@hono/hono";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";

interface FormError {
    error?: string;
    field?: string;
    message?: string;
}

export class MyError extends Error {

    #code: ContentfulStatusCode = 500;
    #formError: Array<FormError> = [];

    constructor() {
        super("MyErrorClass");

        // if (typeof messageOrFormError !== "string") {
        //     if (Array.isArray(messageOrFormError)) {
        //         this.#formError = messageOrFormError;
        //     } else {
        //         this.#formError = [messageOrFormError];
        //     }
        // }
    }

    badRequest(formError: string | Array<FormError>) {
        this.#code = 500;
        if (typeof formError === "string") {
            this.#formError = [{ error: formError }];
        } else {
            this.#formError = formError;
        }
        return this;
    }

    internalServerError(message: string) {
        this.#code = 500;
        this.#formError = [{ error: message }]
        return this;
    }

    unauthorized(message: string) {
        this.#code = 401;
        this.#formError = [{ error: message }]
        return this;
    }

    forbidden(message: string) {
        this.#code = 403;
        this.#formError = [{ error: message }]
        return this;
    }

    getStatus() {
        switch (this.#code) {
            case 400:
                return "Bad Request";

            case 401:
                return "Unauthorized";

            case 403:
                return "Forbidden";

            case 500:
                return "Internal Server Error";

            default:
                return "Internal Server Error";
        }
    }

    // deno-lint-ignore no-explicit-any
    toJSON(json: Context<any, string, object>["json"]) {
        return json({ status: this.getStatus(), errors: this.#formError }, this.#code);
    }

}