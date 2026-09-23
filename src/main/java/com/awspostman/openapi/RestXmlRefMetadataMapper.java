// SPDX-License-Identifier: Apache-2.0

package com.awspostman.openapi;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import software.amazon.smithy.aws.traits.protocols.RestXmlTrait;
import software.amazon.smithy.jsonschema.Schema;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.CollectionShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.ToShapeId;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.Trait;
import software.amazon.smithy.openapi.fromsmithy.Context;
import software.amazon.smithy.openapi.fromsmithy.OpenApiMapper;
import software.amazon.smithy.openapi.model.ComponentsObject;
import software.amazon.smithy.openapi.model.MediaTypeObject;
import software.amazon.smithy.openapi.model.OpenApi;
import software.amazon.smithy.openapi.model.RequestBodyObject;
import software.amazon.smithy.openapi.model.ResponseObject;
import software.amazon.smithy.utils.ListUtils;

/**
 * Restores {@code xmlName}/{@code xmlAttribute}/{@code xmlNamespace} metadata that Smithy's own
 * {@code JsonSchemaShapeVisitor} silently drops for members targeting a non-inlined shape
 * (structures, unions, non-inline maps, enums): that visitor builds a bare {@code {"$ref": ...}}
 * directly, bypassing every registered {@code JsonSchemaMapper} -- including
 * {@link RestXmlJsonSchemaMapper} -- so those members' xml traits never get a chance to attach.
 * This isn't a bug in this project's mapper; it's an upstream fast path (see
 * {@code AbstractRestProtocol}'s own class doc reference in {@code AwsRestXmlProtocol}).
 *
 * <p>Two places this shows up, each fixed differently because each has a different, unambiguous
 * way to find the Smithy member responsible without guessing from the JSON tree alone, and --
 * empirically, against the real {@code openapi-to-postmanv2} library this project's Postman
 * conversion runs on -- each needs a different fix shape to actually render correctly:
 * <ul>
 *   <li>An operation's request/response body is a single httpPayload-bound member targeting a
 *       named structure (the standard AWS pattern for whole-document bodies, e.g.
 *       {@code PutObjectTagging}'s {@code Tagging} payload), or any other direct struct/union/enum-
 *       targeting member. Fixed in {@link #updateRequestBody}/{@link #updateResponse} and in
 *       {@link #after} by rewriting the bare {@code $ref} into
 *       {@code {"allOf": [ref], "xml": {...}}} (OpenAPI 3.0, unlike later JSON Schema drafts,
 *       requires {@code $ref} to be the only keyword in its schema object, so the hint can't just
 *       sit next to it) -- confirmed the faker generates a normal fake value for this shape.</li>
 *   <li>A list/set's item member targets a shared, separately-named structure (the standard AWS
 *       pattern: {@code TagSet}'s items -> {@code Tag}). Fixed in {@link #after} too, but
 *       differently: confirmed the faker generates <strong>zero</strong> array items when
 *       {@code items} is allOf-wrapped, so instead of touching the link, this adds the {@code xml}
 *       hint directly onto the referenced component's own schema (e.g. {@code Tag} itself),
 *       leaving {@code items} a plain, faker-friendly {@code $ref}.</li>
 * </ul>
 *
 * <p>Not handled: map key/value members targeting a named structure. Map schemas use
 * {@code additionalProperties}/{@code propertyNames} rather than {@code properties}, and
 * document-bound maps are rare in the services this project has actually needed (s3, s3-control,
 * cloudfront, route-53) -- not worth the extra branch until a real model needs it.
 */
public final class RestXmlRefMetadataMapper implements OpenApiMapper {

    @Override
    public RequestBodyObject updateRequestBody(
            Context<? extends Trait> context,
            OperationShape operation,
            String httpMethodName,
            String path,
            RequestBodyObject requestBody
    ) {
        if (!isRestXml(context)) {
            return requestBody;
        }
        List<HttpBinding> payload = HttpBindingIndex.of(context.getModel())
                .getRequestBindings(operation, HttpBinding.Location.PAYLOAD);
        if (payload.isEmpty()) {
            return requestBody;
        }
        Map<String, MediaTypeObject> patched = decorateContent(
                requestBody.getContent(), payload.get(0).getMember(), context.getModel());
        return patched == requestBody.getContent() ? requestBody : requestBody.toBuilder().content(patched).build();
    }

    @Override
    public ResponseObject updateResponse(
            Context<? extends Trait> context,
            OperationShape operation,
            String status,
            String httpMethodName,
            String path,
            ResponseObject response
    ) {
        if (!isRestXml(context)) {
            return response;
        }
        Optional<StructureShape> structure = resolveResponseStructure(context, operation, status);
        if (!structure.isPresent()) {
            return response;
        }
        List<HttpBinding> payload = HttpBindingIndex.of(context.getModel())
                .getResponseBindings(structure.get(), HttpBinding.Location.PAYLOAD);
        if (payload.isEmpty()) {
            return response;
        }
        Map<String, MediaTypeObject> patched = decorateContent(
                response.getContent(), payload.get(0).getMember(), context.getModel());
        return patched == response.getContent() ? response : response.toBuilder().content(patched).build();
    }

    // Mirrors the exact status-code computation AbstractRestProtocol used to build the response
    // map in the first place (operation's own status for the output, or each error's own status),
    // so matching against the given `status` reliably identifies which structure this call is for.
    private Optional<StructureShape> resolveResponseStructure(
            Context<? extends Trait> context,
            OperationShape operation,
            String status
    ) {
        OperationIndex operationIndex = OperationIndex.of(context.getModel());
        if (status.equals(statusCodeOf(context, operation))) {
            return Optional.of(operationIndex.expectOutputShape(operation));
        }
        for (StructureShape error : operationIndex.getErrors(operation)) {
            if (status.equals(statusCodeOf(context, error))) {
                return Optional.of(error);
            }
        }
        return Optional.empty();
    }

    // A plain wildcard capture of `context` twice in one expression (once via
    // context.getOpenApiProtocol(), once as the method argument) isn't unified by javac, so this
    // routes through a single generic call to force one consistent capture.
    private <T extends Trait> String statusCodeOf(Context<T> context, ToShapeId shapeId) {
        return context.getOpenApiProtocol().getOperationResponseStatusCode(context, shapeId);
    }

    private Map<String, MediaTypeObject> decorateContent(
            Map<String, MediaTypeObject> content,
            MemberShape payloadMember,
            Model model
    ) {
        Map<String, MediaTypeObject> result = null;
        for (Map.Entry<String, MediaTypeObject> entry : content.entrySet()) {
            Optional<Schema> schema = entry.getValue().getSchema();
            if (!schema.isPresent()) {
                continue;
            }
            Schema patched = decorateBareRef(schema.get(), payloadMember, model);
            if (patched != schema.get()) {
                if (result == null) {
                    result = new LinkedHashMap<>(content);
                }
                result.put(entry.getKey(), entry.getValue().toBuilder().schema(patched).build());
            }
        }
        return result == null ? content : result;
    }

    @Override
    public OpenApi after(Context<? extends Trait> context, OpenApi openapi) {
        if (!isRestXml(context)) {
            return openapi;
        }
        Map<String, Schema> schemas = new LinkedHashMap<>(openapi.getComponents().getSchemas());
        boolean[] changed = {false};

        context.getModel().shapes(StructureShape.class)
                .forEach(shape -> decorateComponent(context, shape, schemas, changed));
        context.getModel().shapes(UnionShape.class)
                .forEach(shape -> decorateComponent(context, shape, schemas, changed));

        if (!changed[0]) {
            return openapi;
        }
        ComponentsObject components = openapi.getComponents().toBuilder().schemas(schemas).build();
        return openapi.toBuilder().components(components).build();
    }

    private void decorateComponent(
            Context<? extends Trait> context,
            Shape shape,
            Map<String, Schema> schemas,
            boolean[] changed
    ) {
        // Named components are keyed by the last segment of their own JSON pointer -- computing it
        // forward from the Smithy shape (rather than guessing backward from the JSON) is what keeps
        // this unambiguous even if some other shape happens to share a simple name.
        String pointer = context.getPointer(shape.getId());
        String name = pointer.substring(pointer.lastIndexOf('/') + 1);
        Schema componentSchema = schemas.get(name);
        if (componentSchema == null || componentSchema.getProperties().isEmpty()) {
            return;
        }

        Model model = context.getModel();
        Schema.Builder rebuilt = null;
        for (Map.Entry<String, Schema> prop : componentSchema.getProperties().entrySet()) {
            Optional<MemberShape> member = shape.getMember(prop.getKey());
            if (!member.isPresent()) {
                continue;
            }

            // Case 1: the member itself targets a non-inlined shape (struct/union/enum/non-inline
            // map) -- the property schema IS the bare ref that lost the member's own xml traits.
            // Wrapping the link in allOf is safe here: confirmed against the real
            // openapi-to-postmanv2 faker that it fakes an allOf-wrapped $ref just like a plain one
            // when it isn't inside an array's "items" (see case 2 for why that caveat matters).
            Schema patchedProp = decorateBareRef(prop.getValue(), member.get(), model);
            if (patchedProp != prop.getValue()) {
                if (rebuilt == null) {
                    rebuilt = componentSchema.toBuilder();
                }
                rebuilt.putProperty(prop.getKey(), patchedProp);
            }

            // Case 2: the member targets a list/set (always inlined), whose OWN item member is the
            // one carrying the override (the standard AWS pattern: TagSet's item member -> xmlName
            // "Tag"). Confirmed empirically against openapi-to-postmanv2 that when "items" is
            // allOf-wrapped instead of a plain $ref, its schema faker generates zero array items --
            // so unlike case 1, the link must stay a bare $ref and the hint has to live on the
            // referenced component's own schema instead (schemas.put(targetName, ...) below).
            if (prop.getValue().getItems().isPresent()) {
                decorateListItemTarget(context, member.get(), prop.getValue().getItems().get(), schemas, changed);
            }
        }

        if (rebuilt != null) {
            schemas.put(name, rebuilt.build());
            changed[0] = true;
        }
    }

    private void decorateListItemTarget(
            Context<? extends Trait> context,
            MemberShape listMember,
            Schema itemsSchema,
            Map<String, Schema> schemas,
            boolean[] changed
    ) {
        if (!isBareRef(itemsSchema)) {
            return;
        }
        Model model = context.getModel();
        Shape target = model.expectShape(listMember.getTarget());
        if (!(target instanceof CollectionShape)) {
            return;
        }
        MemberShape itemMember = ((CollectionShape) target).getMember();
        Optional<ObjectNode> xml = RestXmlJsonSchemaMapper.buildXmlExtension(itemMember, model);
        if (!xml.isPresent()) {
            return;
        }
        String ref = itemsSchema.getRef().get();
        String targetName = ref.substring(ref.lastIndexOf('/') + 1);
        Schema targetSchema = schemas.get(targetName);
        if (targetSchema == null) {
            return;
        }
        // Last write wins if the same shared target is used by multiple lists whose item members
        // disagree on the xml override -- rare in practice (AWS models keep this consistent), and
        // strictly better than every such usage rendering with no override at all.
        schemas.put(targetName, targetSchema.toBuilder().putExtension("xml", xml.get()).build());
        changed[0] = true;
    }

    private Schema decorateBareRef(Schema schema, MemberShape member, Model model) {
        if (!isBareRef(schema)) {
            return schema;
        }
        return RestXmlJsonSchemaMapper.buildXmlExtension(member, model)
                .map(xml -> Schema.builder().allOf(ListUtils.of(schema)).putExtension("xml", xml).build())
                .orElse(schema);
    }

    private boolean isBareRef(Schema schema) {
        return schema.getRef().isPresent()
                && !schema.getType().isPresent()
                && schema.getProperties().isEmpty()
                && !schema.getItems().isPresent()
                && schema.getAllOf().isEmpty();
    }

    private boolean isRestXml(Context<? extends Trait> context) {
        return context.getModel().isTraitApplied(RestXmlTrait.class);
    }
}
