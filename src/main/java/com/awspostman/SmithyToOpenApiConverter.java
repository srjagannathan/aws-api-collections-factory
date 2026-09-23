// SPDX-License-Identifier: Apache-2.0

package com.awspostman;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.Parameters;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.loader.ModelAssembler;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.openapi.OpenApiConfig;
import software.amazon.smithy.openapi.fromsmithy.OpenApiConverter;
import software.amazon.smithy.openapi.model.OpenApi;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

@Command(
    name = "smithy-to-openapi",
    mixinStandardHelpOptions = true,
    version = "1.0.0",
    description = "Converts AWS Smithy models to OpenAPI 3.x specifications"
)
public class SmithyToOpenApiConverter implements Callable<Integer> {

    @Parameters(index = "0", description = "Path to AWS api-models-aws/models directory")
    private Path modelsDir;

    @Option(names = {"-o", "--output"}, description = "Output directory for OpenAPI specs", defaultValue = "output/openapi")
    private Path outputDir;

    @Option(names = {"-s", "--services"}, description = "Comma-separated list of services to convert (empty = all)")
    private String services;

    @Option(names = {"-v", "--openapi-version"}, description = "OpenAPI version (3.0.2 or 3.1.0)", defaultValue = "3.0.2")
    private String openApiVersion;

    @Option(names = {"--dry-run"}, description = "List services without converting")
    private boolean dryRun;

    @Option(names = {"--verbose"}, description = "Verbose output")
    private boolean verbose;

    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private final AtomicInteger successCount = new AtomicInteger(0);
    private final AtomicInteger failCount = new AtomicInteger(0);
    private final List<String> failedServices = Collections.synchronizedList(new ArrayList<>());

    public static void main(String[] args) {
        int exitCode = new CommandLine(new SmithyToOpenApiConverter()).execute(args);
        System.exit(exitCode);
    }

    @Override
    public Integer call() throws Exception {
        // Validate inputs
        if (!Files.isDirectory(modelsDir)) {
            System.err.println("Error: Models directory does not exist: " + modelsDir);
            return 1;
        }

        // Create output directory
        Files.createDirectories(outputDir);

        // Get list of services to process
        List<String> serviceList = getServiceList();
        System.out.println("Found " + serviceList.size() + " services to process");

        if (dryRun) {
            System.out.println("\nServices (dry run):");
            serviceList.forEach(s -> System.out.println("  - " + s));
            return 0;
        }

        // Process each service
        long startTime = System.currentTimeMillis();
        for (String service : serviceList) {
            processService(service);
        }
        long elapsed = System.currentTimeMillis() - startTime;

        // Print summary
        System.out.println("\n========== Conversion Summary ==========");
        System.out.println("Total services: " + serviceList.size());
        System.out.println("Successful: " + successCount.get());
        System.out.println("Failed: " + failCount.get());
        System.out.println("Time: " + (elapsed / 1000.0) + " seconds");

        if (!failedServices.isEmpty()) {
            System.out.println("\nFailed services:");
            failedServices.forEach(s -> System.out.println("  - " + s));
        }

        // Write conversion report
        writeReport(serviceList);

        return failedServices.isEmpty() ? 0 : 1;
    }

    private List<String> getServiceList() throws IOException {
        List<String> allServices = new ArrayList<>();

        try (DirectoryStream<Path> stream = Files.newDirectoryStream(modelsDir)) {
            for (Path entry : stream) {
                if (Files.isDirectory(entry)) {
                    Path serviceDir = entry.resolve("service");
                    if (Files.isDirectory(serviceDir)) {
                        allServices.add(entry.getFileName().toString());
                    }
                }
            }
        }

        Collections.sort(allServices);

        // Filter if specific services requested
        if (services != null && !services.isEmpty()) {
            Set<String> requested = Arrays.stream(services.split(","))
                .map(String::trim)
                .collect(Collectors.toSet());
            return allServices.stream()
                .filter(requested::contains)
                .collect(Collectors.toList());
        }

        return allServices;
    }

    private void processService(String serviceName) {
        System.out.print("Processing " + serviceName + "... ");

        try {
            Path serviceDir = modelsDir.resolve(serviceName).resolve("service");
            Path modelFile = findModelFile(serviceDir);

            if (modelFile == null) {
                System.out.println("SKIP (no model file found)");
                return;
            }

            // Load the Smithy model
            Model model = loadSmithyModel(modelFile);

            // Find the service shape
            Optional<ServiceShape> serviceOpt = model.shapes(ServiceShape.class).findFirst();
            if (serviceOpt.isEmpty()) {
                System.out.println("SKIP (no service shape)");
                return;
            }

            ServiceShape service = serviceOpt.get();
            ShapeId serviceId = service.getId();

            // Detect protocol
            String protocol = detectProtocol(service);
            if (protocol == null) {
                System.out.println("SKIP (no supported protocol)");
                if (verbose) {
                    System.out.println("  Available traits: " + service.getAllTraits().keySet());
                }
                return;
            }

            if (verbose) {
                System.out.println("\n  Service ID: " + serviceId);
                System.out.println("  Protocol: " + protocol);
            }

            // Configure OpenAPI conversion
            OpenApiConfig config = createOpenApiConfig(serviceId, protocol);

            // Convert to OpenAPI
            OpenApi openApi = OpenApiConverter.create()
                .config(config)
                .convert(model);

            // Enhance the OpenAPI spec with AWS-specific info
            ObjectNode openApiNode = openApi.toNode().expectObjectNode();
            JsonObject enhanced = enhanceOpenApiSpec(openApiNode, serviceName, service);

            // Write output
            Path outputFile = outputDir.resolve(serviceName + ".openapi.json");
            Files.writeString(outputFile, gson.toJson(enhanced));

            successCount.incrementAndGet();
            System.out.println("OK (" + protocol + ")");

        } catch (Exception e) {
            failCount.incrementAndGet();
            failedServices.add(serviceName + ": " + e.getMessage());
            System.out.println("FAILED");
            if (verbose) {
                e.printStackTrace();
            }
        }
    }

    private Path findModelFile(Path serviceDir) throws IOException {
        if (!Files.isDirectory(serviceDir)) {
            return null;
        }

        // Deterministic selection: version directories are ISO dates, so the
        // lexicographically latest directory is the newest API version. Within it,
        // sort filenames and take the last.
        List<Path> versionDirs = new ArrayList<>();
        try (DirectoryStream<Path> versions = Files.newDirectoryStream(serviceDir)) {
            for (Path versionDir : versions) {
                if (Files.isDirectory(versionDir)) {
                    versionDirs.add(versionDir);
                }
            }
        }
        versionDirs.sort(Comparator.comparing(p -> p.getFileName().toString()));

        for (int i = versionDirs.size() - 1; i >= 0; i--) {
            List<Path> jsonFiles = new ArrayList<>();
            try (DirectoryStream<Path> files = Files.newDirectoryStream(versionDirs.get(i), "*.json")) {
                for (Path file : files) {
                    jsonFiles.add(file);
                }
            }
            if (!jsonFiles.isEmpty()) {
                jsonFiles.sort(Comparator.comparing(p -> p.getFileName().toString()));
                return jsonFiles.get(jsonFiles.size() - 1);
            }
        }
        return null;
    }

    private Model loadSmithyModel(Path modelFile) {
        ModelAssembler assembler = Model.assembler();

        // Add the model file
        assembler.addImport(modelFile);

        // Discover AWS trait definitions (aws.api#*, aws.iam#*, aws.cloudformation#*, aws.protocols#*)
        // from the smithy-aws-traits / smithy-aws-iam-traits / smithy-aws-cloudformation-traits jars
        // on the classpath. Without this, models fail with "Unable to resolve trait" ERRORs.
        assembler.discoverModels(SmithyToOpenApiConverter.class.getClassLoader());

        // Disable validation to handle incomplete models
        assembler.disableValidation();

        return assembler.assemble().unwrap();
    }

    private String detectProtocol(ServiceShape service) {
        // Check for AWS protocols in order of preference
        String[] protocols = {
            "aws.protocols#restJson1",
            "aws.protocols#restXml",
            "aws.protocols#awsJson1_1",
            "aws.protocols#awsJson1_0",
            "aws.protocols#awsQuery",
            "aws.protocols#ec2Query"
        };

        for (String protocol : protocols) {
            if (service.hasTrait(ShapeId.from(protocol))) {
                return protocol;
            }
        }

        return null;
    }

    private OpenApiConfig createOpenApiConfig(ShapeId serviceId, String protocol) {
        ObjectNode.Builder configBuilder = ObjectNode.builder()
            .withMember("service", serviceId.toString())
            .withMember("protocol", protocol)
            .withMember("version", openApiVersion)
            .withMember("jsonContentType", "application/json")
            .withMember("tags", true)
            .withMember("keepUnusedComponents", false)
            .withMember("alphanumericOnlyRefs", true)
            // Skip (rather than abort on) HTTP-binding traits the converter cannot map,
            // e.g. smithy.api#endpoint hostPrefix traits used by connecthealth.
            .withMember("ignoreUnsupportedTraits", true)
            // httpPrefixHeaders (e.g. S3's GetObjectOutput$Metadata -> x-amz-meta-*) has no OpenAPI
            // representation (no wildcard/prefix header parameter concept); omit it with a warning
            // instead of aborting the whole service's conversion.
            .withMember("onHttpPrefixHeaders", "WARN");

        return OpenApiConfig.fromNode(configBuilder.build());
    }

    private JsonObject enhanceOpenApiSpec(ObjectNode openApiNode, String serviceName, ServiceShape service) {
        // Convert Smithy node to Gson JsonObject
        String json = Node.printJson(openApiNode);
        JsonObject spec = JsonParser.parseString(json).getAsJsonObject();

        // Enhance info section
        if (spec.has("info")) {
            JsonObject info = spec.getAsJsonObject("info");

            // Add x-logo extension for documentation
            JsonObject xLogo = new JsonObject();
            xLogo.addProperty("url", "https://aws.amazon.com/favicon.ico");
            xLogo.addProperty("altText", "AWS");
            info.add("x-logo", xLogo);

            // Add contact info
            JsonObject contact = new JsonObject();
            contact.addProperty("name", "AWS Support");
            contact.addProperty("url", "https://aws.amazon.com/support");
            info.add("contact", contact);
        }

        // Enhance servers section with regional endpoints
        enhanceServers(spec, serviceName, service);

        // Add security schemes
        enhanceSecuritySchemes(spec, serviceName);

        return spec;
    }

    private void enhanceServers(JsonObject spec, String serviceName, ServiceShape service) {
        // Get endpoint prefix from service traits
        String endpointPrefix = serviceName;
        if (service.hasTrait(ShapeId.from("aws.api#service"))) {
            try {
                ObjectNode serviceTraitNode = service.expectTrait(
                    software.amazon.smithy.aws.traits.ServiceTrait.class
                ).toNode().expectObjectNode();

                if (serviceTraitNode.getMember("endpointPrefix").isPresent()) {
                    endpointPrefix = serviceTraitNode.getMember("endpointPrefix").get().expectStringNode().getValue();
                }
            } catch (Exception e) {
                // Use default
            }
        }

        // Create server template with variables
        com.google.gson.JsonArray servers = new com.google.gson.JsonArray();
        JsonObject server = new JsonObject();
        server.addProperty("url", "https://{service}.{region}.amazonaws.com");
        server.addProperty("description", "AWS " + serviceName + " regional endpoint");

        JsonObject variables = new JsonObject();

        JsonObject serviceVar = new JsonObject();
        serviceVar.addProperty("default", endpointPrefix);
        serviceVar.addProperty("description", "AWS service endpoint prefix");
        variables.add("service", serviceVar);

        JsonObject regionVar = new JsonObject();
        regionVar.addProperty("default", "us-east-1");
        regionVar.addProperty("description", "AWS region");
        com.google.gson.JsonArray regionEnum = new com.google.gson.JsonArray();
        regionEnum.add("us-east-1");
        regionEnum.add("us-east-2");
        regionEnum.add("us-west-1");
        regionEnum.add("us-west-2");
        regionEnum.add("eu-west-1");
        regionEnum.add("eu-west-2");
        regionEnum.add("eu-central-1");
        regionEnum.add("ap-northeast-1");
        regionEnum.add("ap-southeast-1");
        regionEnum.add("ap-southeast-2");
        regionVar.add("enum", regionEnum);
        variables.add("region", regionVar);

        server.add("variables", variables);
        servers.add(server);

        spec.add("servers", servers);
    }

    private void enhanceSecuritySchemes(JsonObject spec, String serviceName) {
        // Ensure components exists
        if (!spec.has("components")) {
            spec.add("components", new JsonObject());
        }
        JsonObject components = spec.getAsJsonObject("components");

        // Add security schemes
        if (!components.has("securitySchemes")) {
            components.add("securitySchemes", new JsonObject());
        }
        JsonObject securitySchemes = components.getAsJsonObject("securitySchemes");

        // AWS SigV4 (represented as apiKey for OpenAPI compatibility)
        JsonObject sigv4 = new JsonObject();
        sigv4.addProperty("type", "apiKey");
        sigv4.addProperty("name", "Authorization");
        sigv4.addProperty("in", "header");
        sigv4.addProperty("description", "AWS Signature Version 4 authentication");
        sigv4.addProperty("x-amazon-apigateway-authtype", "awsSigv4");
        securitySchemes.add("aws_sigv4", sigv4);

        // Add global security requirement
        com.google.gson.JsonArray security = new com.google.gson.JsonArray();
        JsonObject sigv4Requirement = new JsonObject();
        sigv4Requirement.add("aws_sigv4", new com.google.gson.JsonArray());
        security.add(sigv4Requirement);
        spec.add("security", security);
    }

    private void writeReport(List<String> serviceList) throws IOException {
        JsonObject report = new JsonObject();
        report.addProperty("timestamp", java.time.Instant.now().toString());
        report.addProperty("totalServices", serviceList.size());
        report.addProperty("successful", successCount.get());
        report.addProperty("failed", failCount.get());
        report.addProperty("openApiVersion", openApiVersion);

        com.google.gson.JsonArray successfulArray = new com.google.gson.JsonArray();
        com.google.gson.JsonArray failedArray = new com.google.gson.JsonArray();

        for (String service : serviceList) {
            if (failedServices.stream().anyMatch(f -> f.startsWith(service + ":"))) {
                failedArray.add(service);
            } else {
                successfulArray.add(service);
            }
        }

        report.add("successfulServices", successfulArray);
        report.add("failedServices", failedArray);

        com.google.gson.JsonArray errors = new com.google.gson.JsonArray();
        for (String error : failedServices) {
            errors.add(error);
        }
        report.add("errors", errors);

        Path reportFile = outputDir.resolve("conversion-report.json");
        Files.writeString(reportFile, gson.toJson(report));
        System.out.println("\nReport written to: " + reportFile);
    }
}
