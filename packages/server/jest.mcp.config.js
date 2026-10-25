module.exports = {
    testEnvironment: "node",
    testMatch: ["<rootDir>/test/mcp*.test.ts"],
    moduleNameMapper: {
        "^@server$": "<rootDir>/test/support/mcpServerMock.ts",
        "^@server/(.*)$": "<rootDir>/src/server/$1"
    },
    transform: {
        "^.+\\.tsx?$": [
            "babel-jest",
            {
                presets: [["@babel/preset-env", { targets: { node: "current" } }], ["@babel/preset-typescript"]]
            }
        ]
    }
};
