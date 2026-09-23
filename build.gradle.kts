// SPDX-License-Identifier: Apache-2.0

plugins {
    java
    application
}

repositories {
    mavenCentral()
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

dependencies {
    // Smithy core and OpenAPI conversion
    implementation("software.amazon.smithy:smithy-model:1.72.1")
    implementation("software.amazon.smithy:smithy-openapi:1.72.1")
    // smithy-openapi pulls this in transitively, but com.awspostman.openapi.* and the restXml
    // OpenApiProtocol below import its classes (Schema, JsonSchemaMapper) directly.
    implementation("software.amazon.smithy:smithy-jsonschema:1.72.1")
    implementation("software.amazon.smithy:smithy-aws-traits:1.72.1")
    implementation("software.amazon.smithy:smithy-aws-iam-traits:1.72.1")
    implementation("software.amazon.smithy:smithy-aws-cloudformation-traits:1.72.1")
    implementation("software.amazon.smithy:smithy-rules-engine:1.72.1")
    // AWS-specific endpoint rules functions (aws.partition, aws.parseArn, ...) registered
    // into the rules engine via SPI; required to parse smithy.rules#endpointBdd/RuleSet.
    implementation("software.amazon.smithy:smithy-aws-endpoints:1.72.1")
    // smithy.test#smokeTests trait definition + the aws.test#AwsVendorParams shape it
    // references (used by connecthealth). Required because ALLOW_UNKNOWN_TRAITS is off.
    implementation("software.amazon.smithy:smithy-smoke-test-traits:1.72.1")
    implementation("software.amazon.smithy:smithy-aws-smoke-test-model:1.72.1")
    // smithy.waiters#waitable trait definition (used by lambda). Required because
    // ALLOW_UNKNOWN_TRAITS is off.
    implementation("software.amazon.smithy:smithy-waiters:1.72.1")

    // JSON processing
    implementation("com.google.code.gson:gson:2.10.1")

    // CLI argument parsing
    implementation("info.picocli:picocli:4.7.5")
}

application {
    mainClass.set("com.awspostman.SmithyToOpenApiConverter")
}

// NOTE: No fat-jar packaging. Merging dependency jars with DuplicatesStrategy.EXCLUDE
// clobbers Smithy SPI/manifest files (META-INF/services, META-INF/smithy), silently
// breaking trait discovery. Use `installDist` (build/install/.../bin) as the only
// supported runnable artifact.
