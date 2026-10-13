import com.atxx.jhmcp.*;
import com.google.gson.*;
import io.modelcontextprotocol.kotlin.sdk.server.*;
import io.modelcontextprotocol.kotlin.sdk.types.*;
import jadx.api.*;
import jadx.core.dex.nodes.*;
import java.io.PrintStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Collectors;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import kotlin.Unit;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;
import kotlinx.io.CoreKt;
import kotlinx.io.JvmCoreKt;
import kotlinx.serialization.json.JsonObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;

/** REA-owned metadata boundary for the unmodified jadx-headless-mcp 0.7.1 JAR. */
class ReaJadxBridge {
  private static final Gson JSON = new Gson();
  private static final int MAX_MANIFEST_BYTES = 1_048_576;
  private static final int MAX_DECLARATION_BYTES = 2_097_152;
  private static final int MAX_XML_ELEMENTS = 20_000;
  private static final int MAX_XML_ATTRIBUTES = 100_000;
  private static final Set<String> COMPONENT_ELEMENTS = Set.of(
      "activity", "activity-alias", "service", "receiver", "provider");
  private static final Set<String> REQUESTED_PERMISSION_ELEMENTS = Set.of(
      "uses-permission", "uses-permission-sdk-23", "uses-permission-sdk-m");
  private static final Set<String> DEFINED_PERMISSION_ELEMENTS = Set.of(
      "permission", "permission-group", "permission-tree");
  private final SessionHolder holder;
  private JadxSession indexedSession;
  private Map<String, List<ClassSnapshot>> classes = Map.of();

  private record MethodSnapshot(String name, String shortId, Map<String, Object> summary) {}
  private record ClassSnapshot(JavaClass node, List<MethodSnapshot> methods, Map<String, Object> summary) {}

  private static final class InputFailure extends IllegalArgumentException {
    final String field;
    InputFailure(String field, String message) { super(message); this.field = field; }
  }

  private ReaJadxBridge(SessionHolder holder) { this.holder = holder; }

  private static CallToolResult text(String value, boolean failed) {
    return new CallToolResult(List.of(new TextContent(value, null, null)), failed, null, null);
  }

  private static CallToolResult json(Object value) { return text(JSON.toJson(value), false); }

  private static List<Map<String, String>> attributes(Element element) {
    List<Map<String, String>> result = new ArrayList<>();
    NamedNodeMap source = element.getAttributes();
    for (int index = 0; index < source.getLength(); index++) {
      Node attribute = source.item(index);
      result.add(Map.of(
          "qualified_name", attribute.getNodeName(),
          "local_name", attribute.getLocalName() == null
              ? attribute.getNodeName() : attribute.getLocalName(),
          "namespace_uri", attribute.getNamespaceURI() == null
              ? "" : attribute.getNamespaceURI(),
          "value", attribute.getNodeValue()));
    }
    result.sort(Comparator.comparing(item -> item.get("qualified_name")));
    return result;
  }

  private static List<Element> children(Element parent) {
    List<Element> result = new ArrayList<>();
    NodeList nodes = parent.getChildNodes();
    for (int index = 0; index < nodes.getLength(); index++)
      if (nodes.item(index) instanceof Element element) result.add(element);
    return result;
  }

  private static Map<String, Object> element(Element value) {
    return Map.of("element_name", value.getTagName(), "attributes", attributes(value));
  }

  private static Map<String, Object> intentFilter(Element filter) {
    List<Map<String, Object>> actions = new ArrayList<>();
    List<Map<String, Object>> categories = new ArrayList<>();
    List<Map<String, Object>> data = new ArrayList<>();
    for (Element child : children(filter)) {
      switch (child.getTagName()) {
        case "action" -> actions.add(element(child));
        case "category" -> categories.add(element(child));
        case "data" -> data.add(element(child));
        default -> { /* Original XML retains unrecognized declarations. */ }
      }
    }
    return Map.of("attributes", attributes(filter), "actions", actions,
        "categories", categories, "data", data);
  }

  private static Map<String, Object> component(Element value) {
    List<Map<String, Object>> filters = children(value).stream()
        .filter(child -> child.getTagName().equals("intent-filter"))
        .map(ReaJadxBridge::intentFilter).toList();
    return Map.of("element_name", value.getTagName(), "attributes", attributes(value),
        "intent_filters", filters);
  }

  private static CallToolResult manifestDeclarations(JadxSession current) {
    String source = current.getManifestText();
    if (source == null || source.isBlank())
      return json(Map.of("status", "unavailable", "reason", "JADX supplied no decoded manifest XML"));
    if (source.length() > MAX_MANIFEST_BYTES)
      return json(Map.of("status", "unavailable", "reason", "Decoded manifest exceeds the 1 MiB declaration parsing budget"));
    byte[] sourceBytes = source.getBytes(StandardCharsets.UTF_8);
    if (sourceBytes.length > MAX_MANIFEST_BYTES)
      return json(Map.of("status", "unavailable", "reason", "Decoded manifest exceeds the 1 MiB declaration parsing budget"));
    try {
      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      factory.setNamespaceAware(true);
      factory.setXIncludeAware(false);
      factory.setExpandEntityReferences(false);
      factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
      factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
      factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
      factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
      factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
      var builder = factory.newDocumentBuilder();
      builder.setErrorHandler(new org.xml.sax.helpers.DefaultHandler() {
        @Override public void error(org.xml.sax.SAXParseException failure) throws SAXException {
          throw failure;
        }
        @Override public void fatalError(org.xml.sax.SAXParseException failure) throws SAXException {
          throw failure;
        }
      });
      Document document = builder.parse(new InputSource(new StringReader(source)));
      Element manifest = document.getDocumentElement();
      if (manifest == null || !manifest.getTagName().equals("manifest"))
        return json(Map.of("status", "unavailable", "reason", "Decoded XML has no manifest root"));
      Deque<Element> pending = new ArrayDeque<>();
      pending.push(manifest);
      int elementCount = 1;
      int attributeCount = 0;
      while (!pending.isEmpty()) {
        Element next = pending.pop();
        attributeCount += next.getAttributes().getLength();
        if (attributeCount > MAX_XML_ATTRIBUTES)
          return json(Map.of("status", "unavailable", "reason", "Decoded manifest exceeds the 100,000-attribute parsing budget"));
        NodeList nested = next.getChildNodes();
        for (int index = 0; index < nested.getLength(); index++) {
          if (nested.item(index) instanceof Element child) {
            if (++elementCount > MAX_XML_ELEMENTS)
              return json(Map.of("status", "unavailable", "reason", "Decoded manifest exceeds the 20,000-element parsing budget"));
            pending.push(child);
          }
        }
      }
      List<Map<String, Object>> applications = new ArrayList<>();
      List<Map<String, Object>> requestedPermissions = new ArrayList<>();
      List<Map<String, Object>> definedPermissions = new ArrayList<>();
      List<Map<String, Object>> components = new ArrayList<>();
      for (Element child : children(manifest)) {
        String name = child.getTagName();
        if (REQUESTED_PERMISSION_ELEMENTS.contains(name)) requestedPermissions.add(element(child));
        if (DEFINED_PERMISSION_ELEMENTS.contains(name)) definedPermissions.add(element(child));
        if (name.equals("application")) {
          applications.add(element(child));
          for (Element applicationChild : children(child))
            if (COMPONENT_ELEMENTS.contains(applicationChild.getTagName()))
              components.add(component(applicationChild));
        }
      }
      String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sourceBytes));
      Map<String, Object> result = Map.of(
          "status", "complete", "source_sha256", digest,
          "manifest_attributes", attributes(manifest), "applications", applications,
          "requested_permissions", requestedPermissions,
          "defined_permissions", definedPermissions, "components", components);
      if (JSON.toJson(result).getBytes(StandardCharsets.UTF_8).length > MAX_DECLARATION_BYTES)
        return json(Map.of("status", "unavailable", "reason", "Structured declarations exceed the 2 MiB output budget"));
      return json(result);
    } catch (Exception error) {
      if (error instanceof SAXException || error instanceof javax.xml.parsers.ParserConfigurationException
          || error instanceof java.io.IOException)
        return json(Map.of("status", "unavailable", "reason", "Decoded manifest XML could not be parsed: " + error.getMessage()));
      throw new IllegalStateException("Manifest declaration projection failed", error);
    }
  }

  private static String string(JsonObject args, String name) {
    JsonElement value = JsonParser.parseString(args.toString()).getAsJsonObject().get(name);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
      throw new IllegalArgumentException(name + " must be a string");
    return value.getAsString();
  }

  private static int integer(JsonObject args, String name, int fallback) {
    JsonElement value = JsonParser.parseString(args.toString()).getAsJsonObject().get(name);
    if (value == null) return fallback;
    if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException(name + " must be a nonnegative integer");
    try {
      int result = value.getAsBigDecimal().intValueExact();
      if (result < 0) throw new ArithmeticException();
      return result;
    } catch (ArithmeticException error) {
      throw new IllegalArgumentException(name + " must be a nonnegative integer", error);
    }
  }

  private JadxSession session() {
    JadxSession current = holder.current();
    if (current == null) throw new IllegalArgumentException("No APK loaded");
    return current;
  }

  private ClassSnapshot selected(JsonObject args) {
    JadxSession current = session();
    if (indexedSession != current) {
      Map<String, List<ClassSnapshot>> index = new LinkedHashMap<>();
      if (!current.getClasses().isEmpty()) {
        JadxDecompiler decompiler = current.getClasses().get(0).getClassNode().root().getDecompiler();
        // JavaClass.getMethods/getFields/getInnerClasses all load code. Raw nodes do not.
        // Snapshot every identity before code generation can rewrite aliases or members.
        for (JavaClass cls : decompiler.getClassesWithInners()) {
          ClassNode node = cls.getClassNode();
          List<MethodNode> ordered = new ArrayList<>(node.getMethods());
          ordered.sort(Comparator.comparing(MethodNode::getAlias));
          List<MethodSnapshot> methods = ordered.stream().map(method -> {
            String name = method.getAlias();
            String signature = name + "(" + method.getArgTypes().stream()
                .map(Object::toString).collect(Collectors.joining(", "))
                + "): " + method.getReturnType().toString();
            return new MethodSnapshot(name, method.getMethodInfo().getShortId(), Map.of(
                "name", name, "signature", signature,
                "is_constructor", method.isConstructor(), "def_pos", 0));
          }).toList();
          List<Map<String, Object>> fields = node.getFields().stream()
              .sorted(Comparator.comparing(FieldNode::getAlias))
              .map(field -> Map.<String, Object>of("name", field.getAlias(),
                  "type", field.getType().toString(), "def_pos", 0)).toList();
          List<String> inner = node.getInnerClasses().stream().map(ClassNode::getFullName).toList();
          Map<String, Object> summary = Map.of(
              "full_name", cls.getFullName(), "name", cls.getName(),
              "method_count", methods.size(), "field_count", fields.size(),
              "inner_class_count", inner.size(), "inner_classes", inner,
              "methods", methods.stream().map(MethodSnapshot::summary).toList(), "fields", fields);
          index.computeIfAbsent(cls.getFullName(), ignored -> new ArrayList<>())
              .add(new ClassSnapshot(cls, methods, summary));
        }
      }
      classes = Collections.unmodifiableMap(index);
      indexedSession = current;
    }
    String name = string(args, "class_name");
    List<ClassSnapshot> candidates = classes.get(name);
    if (candidates == null) throw new InputFailure("class_name", "Exact class not found: " + name
        + "; use search_android_classes to discover fully qualified names.");
    if (candidates.size() != 1) throw new InputFailure("class_name", "Ambiguous metadata class identity: " + name
        + "; raw identities: " + candidates.stream().map(candidate -> candidate.node().getRawName()).toList());
    return candidates.get(0);
  }

  private List<MethodSnapshot> methods(ClassSnapshot cls, JsonObject args) {
    String name = string(args, "method_name");
    List<MethodSnapshot> result = cls.methods().stream().filter(method -> method.name().equals(name)).toList();
    if (result.isEmpty()) throw new InputFailure("method_name", "Method not found: " + name
        + "; use inspect_android_class to discover available methods.");
    return result;
  }

  private JavaMethod method(ClassSnapshot cls, MethodSnapshot selected) {
    JavaMethod result = cls.node().searchMethodByShortId(selected.shortId());
    if (result == null) throw new IllegalArgumentException("Method identity no longer available: " + selected.shortId());
    return result;
  }

  private JadxSession.SmartCode methodBody(JadxSession current, ClassSnapshot cls,
      MethodSnapshot selected, JavaMethod method) {
    if (!selected.shortId().equals("<clinit>()V"))
      return current.getMethodBodySmart(method, current.getMaxSourceBytes(), true);
    // Java code generation can fold all or part of <clinit> into field declarations.
    // Its method text cannot establish coverage, even when a static block remains.
    JadxSession.MethodSmali smali = current.getMethodSmali(cls.node(), method.getName());
    if (!smali.getFound() || smali.getBlocks().size() != 1)
      throw new IllegalArgumentException("Static initializer disassembly requires one exact method: " + selected.shortId());
    return new JadxSession.SmartCode(
        TextUtilKt.truncateToBytes(smali.getBlocks().get(0), current.getMaxSourceBytes()),
        "smali", true, List.of("static_initializer_disassembly"));
  }

  private CallToolResult handle(String name, JsonObject args) {
    if (name.equals("rea_jvm_status")) return json(Map.of(
        "engine_reported_version", BuildInfo.VERSION,
        "max_heap_bytes", Runtime.getRuntime().maxMemory(),
        "available_processors", Runtime.getRuntime().availableProcessors(),
        "java_version", System.getProperty("java.version"),
        "metadata_scope", "parsed_members"));
    JadxSession current = session();
    if (name.equals("rea_manifest_declarations")) return manifestDeclarations(current);
    if (name.equals("list_classes")) {
      List<String> names = current.getClassFqns();
      int offset = integer(args, "offset", 0);
      int limit = integer(args, "limit", 200);
      int start = Math.min(offset, names.size());
      int end = (int) Math.min((long) start + limit, names.size());
      return json(Map.of("total", names.size(), "offset", offset, "limit", limit,
          "items", names.subList(start, end)));
    }
    ClassSnapshot cls = selected(args);
    if (name.equals("get_class_summary")) return json(cls.summary());
    if (name.equals("get_method_body")) {
      List<MethodSnapshot> overloads = methods(cls, args);
      int index = integer(args, "overload_index", 0);
      if (index >= overloads.size()) throw new InputFailure("overload_index", "overload_index out of range: " + index);
      JavaMethod method = method(cls, overloads.get(index));
      JadxSession.SmartCode code = methodBody(current, cls, overloads.get(index), method);
      return json(Map.of("class_name", cls.summary().get("full_name"),
          "method_name", overloads.get(index).name(), "full_name", method.getFullName(),
          "overload_index", index, "overload_count", overloads.size(),
          "mode", code.getKind(), "fell_back", code.getFellBack(),
          "markers", code.getMarkers(), "body", code.getText()));
    }
    List<JavaNode> uses;
    String target = string(args, "class_name");
    if (name.equals("get_xrefs_to_class")) uses = cls.node().getUseIn();
    else {
      List<MethodSnapshot> overloads = methods(cls, args);
      if (overloads.size() != 1) throw new InputFailure("method_name", "Method references require a unique overload");
      target += "." + overloads.get(0).name();
      uses = method(cls, overloads.get(0)).getUseIn();
    }
    // REA consumes all references without materializing source line information.
    List<Map<String, Object>> items = uses.stream().map(node -> current.describeUsage(node, false)).toList();
    return json(Map.of("target", target, "total", uses.size(), "count", items.size(),
        "resolve_line", false, "items", items));
  }

  public static void main(String[] args) throws Exception {
    PrintStream protocolOut = System.out;
    System.setOut(System.err);
    SessionHolder holder = new SessionHolder(new SessionConfig(
        1048576, 0, 90000L, 1, List.of(), List.of(), 64, ResourceMode.FULL));
    ServerCapabilities capabilities = new ServerCapabilities(
        new ServerCapabilities.Tools(null), null, null, null, null, null, null, Map.of());
    Server server = new Server(new Implementation("rea-jadx-bridge", "1", null, null, null),
        new ServerOptions(capabilities), "", ignored -> Unit.INSTANCE);
    SessionToolsKt.registerSessionTools(server, holder);
    ManifestToolsKt.registerManifestTools(server, holder);
    ClassToolsKt.registerClassTools(server, holder);
    MethodToolsKt.registerMethodTools(server, holder);
    XrefToolsKt.registerXrefTools(server, holder);
    ReaJadxBridge bridge = new ReaJadxBridge(holder);
    Set<String> consumed = Set.of("load_apk", "get_app_info", "get_android_manifest",
        "list_classes", "get_class_summary", "get_method_body",
        "get_xrefs_to_class", "get_xrefs_to_method");
    for (String name : new ArrayList<>(server.getTools().keySet()))
      if (!consumed.contains(name)) server.removeTool(name);
    Tool diagnostics = new Tool("rea_jvm_status",
        new ToolSchema(null, new JsonObject(Map.of()), List.of(), null),
        "Observed worker JVM and metadata scope", null, null, null, null, null, null);
    server.addTool(diagnostics, (connection, request, continuation) -> bridge.handle("rea_jvm_status", request.getArguments()));
    Tool manifestDeclarations = new Tool("rea_manifest_declarations",
        new ToolSchema(null, new JsonObject(Map.of()), List.of(), null),
        "Declared Android manifest components, intent filters, and permissions from decoded XML", null, null, null, null, null, null);
    server.addTool(manifestDeclarations, (connection, request, continuation) -> bridge.handle("rea_manifest_declarations", request.getArguments()));
    for (String name : List.of("list_classes", "get_class_summary",
        "get_method_body", "get_xrefs_to_class", "get_xrefs_to_method")) {
      Tool tool = server.getTools().get(name).getTool();
      server.removeTool(name);
      List<String> fields = switch (name) {
        case "list_classes" -> List.of("offset", "limit");
        case "get_method_body" -> List.of("class_name", "method_name", "overload_index");
        case "get_xrefs_to_method" -> List.of("class_name", "method_name");
        default -> List.of("class_name");
      };
      Map<String, kotlinx.serialization.json.JsonElement> properties = new LinkedHashMap<>();
      for (String field : fields) properties.put(field, tool.getInputSchema().getProperties().get(field));
      String description = switch (name) {
        case "list_classes" -> "Indexed pages of all top-level class names, with offset and limit.";
        case "get_class_summary" -> "Parsed member metadata for one exact class name; no source generation.";
        case "get_method_body" -> "Source for an exact class and stable same-name overload index; static initializers use smali to preserve folded field initialization.";
        default -> "Complete static references to an exact class or unique method; source lines are unresolved.";
      };
      Tool narrowed = new Tool(name, new ToolSchema(null, new JsonObject(properties),
          tool.getInputSchema().getRequired(), null), description, null, null, null, null, null, null);
      server.addTool(narrowed, (connection, request, continuation) -> {
        try { return bridge.handle(name, request.getArguments()); }
        catch (InputFailure error) { return text(JSON.toJson(Map.of(
            "kind", "invalid-input", "field", error.field, "message", error.getMessage())), true); }
        catch (IllegalArgumentException error) { return text(error.getMessage(), true); }
      });
    }
    CountDownLatch done = new CountDownLatch(1);
    server.onClose(() -> { done.countDown(); return Unit.INSTANCE; });
    StdioServerTransport transport = new StdioServerTransport(
        CoreKt.buffered(JvmCoreKt.asSource(System.in)),
        CoreKt.buffered(JvmCoreKt.asSink(protocolOut)));
    transport.onClose(() -> { done.countDown(); return Unit.INSTANCE; });
    ServerSession connection = null;
    try {
      connection = BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> server.createSession(transport, continuation));
      done.await();
    } finally {
      try {
        if (connection != null) {
          ServerSession connected = connection;
          // Unsubscribe the connection before the SDK joins its notification service.
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> connected.close(continuation));
        }
      } finally {
        try {
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> server.close(continuation));
        } finally {
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> holder.unload(continuation));
        }
      }
    }
  }
}
