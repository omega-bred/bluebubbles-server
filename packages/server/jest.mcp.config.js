module.exports = {
    testEnvironment: "node",
    testMatch: ["<rootDir>/test/mcp*Helpers.test.ts"],
    transform: {
        "^.+\\.tsx?$": [
            "babel-jest",
            {
                presets: [
                    ["@babel/preset-env", { targets: { node: "current" } }],
                    ["@babel/preset-typescript"]
                ]
            }
        ]
    }
};
