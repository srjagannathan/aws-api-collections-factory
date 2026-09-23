// SPDX-License-Identifier: Apache-2.0

plugins {
    // Lets Gradle auto-download the pinned JDK 17 toolchain when the local
    // machine doesn't have a matching JDK installed (e.g. after upgrading
    // the system JDK to a newer version).
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "aws-api-collections-factory"
