import pino from "pino";
import config from "./config.js";

const pinoConfig = {
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
};

let logger;
try {
  if (config.env !== "production") {
    logger = pino(
      pinoConfig,
      pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      })
    );
  } else {
    logger = pino(pinoConfig);
  }
} catch {
  logger = pino(pinoConfig);
}

export default logger;
