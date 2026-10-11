import com.atxx.jhmcp.*;
import com.google.gson.*;
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult;
import io.modelcontextprotocol.kotlin.sdk.types.TextContent;
import jadx.api.*;
import jadx.core.dex.nodes.*;
import java.lang.reflect.*;
import java.util.*;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;

/** Real audited-JAR regression; synthetic protocol fixtures cannot prove absence of code generation. */
public class ReaJadxMetadataRegression {
  private static void require(boolean condition, String reason) {
    if (!condition) throw new AssertionError(reason);
  }

  private static JsonObject call(Method handle, Object bridge, String operation, JsonObject arguments)
      throws Exception {
    var input = (kotlinx.serialization.json.JsonObject)
        kotlinx.serialization.json.Json.Default.parseToJsonElement(arguments.toString());
    CallToolResult response;
    try {
      response = (CallToolResult) handle.invoke(bridge, operation, input);
    } catch (InvocationTargetException failure) {
      throw new AssertionError(operation + " failed", failure.getCause());
    }
    require(!Boolean.TRUE.equals(response.isError()), operation + " returned an error");
    require(response.getContent().size() == 1 && response.getContent().get(0) instanceof TextContent,
        "Unsupported response envelope");
    return JsonParser.parseString(((TextContent) response.getContent().get(0)).getText()).getAsJsonObject();
  }

  private static JsonObject arguments(String className) {
    JsonObject value = new JsonObject();
    value.addProperty("class_name", className);
    return value;
  }

  private static JsonObject initializer(Method handle, Object bridge) throws Exception {
    JsonObject input = arguments("io.appium.android.apis.ApiDemos");
    input.addProperty("method_name", "<clinit>");
    JsonObject result = call(handle, bridge, "get_method_body", input);
    require(result.get("mode").getAsString().equals("smali"),
        "A code-bearing folded initializer must return smali instead of a native/abstract stub");
    require(result.get("fell_back").getAsBoolean(), "Initializer fallback was not reported");
    require(result.getAsJsonArray("markers").contains(new JsonPrimitive("java-body-not-emitted")),
        "Missing Java initializer body was not reported");
    require(result.get("overload_index").getAsInt() == 0 && result.get("overload_count").getAsInt() == 1,
        "Initializer identity changed");
    String body = result.get("body").getAsString();
    require(body.lines().filter(line -> line.stripLeading().startsWith(".method ")).count() == 1
        && body.lines().filter(line -> line.strip().equals(".end method")).count() == 1,
        "Initializer fallback must contain exactly one complete method");
    require(body.lines().anyMatch(line -> line.stripLeading().startsWith(".method ")
            && line.stripTrailing().endsWith(" <clinit>()V")) && body.contains("new-instance")
        && body.contains("invoke-direct") && body.contains("sput-object")
        && body.contains("sDisplayNameComparator:Ljava/util/Comparator;")
        && body.contains("return-void"), "Original Comparator initialization instructions were lost: " + body);
    require(!body.contains("native/abstract"), "Initializer was misclassified as native/abstract");
    require(result.equals(call(handle, bridge, "get_method_body", input)),
        "Repeated initializer lookup changed after code generation");
    return result;
  }

  public static void main(String[] args) throws Exception {
    SessionConfig config = new SessionConfig(1048576, 0, 90000L, 1, List.of(), List.of(), 64, ResourceMode.FULL);
    SessionHolder holder = new SessionHolder(config);
    try {
      BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> holder.load(args[0], config, continuation));
      JadxSession session = holder.current();
      require(session != null && !session.getClasses().isEmpty(), "Fixture did not load classes");
      JadxDecompiler decompiler = session.getClasses().get(0).getClassNode().root().getDecompiler();
      IdentityHashMap<ClassNode, ProcessState> states = new IdentityHashMap<>();
      for (ClassNode node : decompiler.getRoot().getClasses()) {
        require(node.getState() == ProcessState.NOT_LOADED, "Fixture unexpectedly generated source");
        states.put(node, node.getState());
      }
      Class<?> bridgeType = Class.forName("ReaJadxBridge");
      Constructor<?> constructor = bridgeType.getDeclaredConstructor(SessionHolder.class);
      constructor.setAccessible(true);
      Object bridge = constructor.newInstance(holder);
      Method handle = bridgeType.getDeclaredMethod("handle", String.class, kotlinx.serialization.json.JsonObject.class);
      handle.setAccessible(true);
      JsonObject apiArgs = arguments("io.appium.android.apis.ApiDemos");
      JsonObject apiSummary = call(handle, bridge, "get_class_summary", apiArgs);
      for (var entry : states.entrySet()) require(entry.getKey().getState() == entry.getValue(),
          "Metadata generated source: " + entry.getKey().getRawName());
      require(states.size() == decompiler.getRoot().getClasses().size(), "Metadata changed class inventory");
      require(apiSummary.getAsJsonArray("fields").get(0).getAsJsonObject().get("type").getAsString().contains("Comparator"),
          "Generic field type was truncated");
      ClassNode apiNode = decompiler.searchClassNodeByOrigFullName("io.appium.android.apis.ApiDemos");
      MethodNode originalInitializer = apiNode.searchMethodByShortId("<clinit>()V");
      require(originalInitializer != null && originalInitializer.getCodeReader() != null
          && originalInitializer.getCodeReader().getUnitsCount() > 0,
          "Fixture initializer must contain original DEX instructions");
      require(!originalInitializer.getAccessFlags().isNative() && !originalInitializer.getAccessFlags().isAbstract(),
          "Fixture initializer must not be native or abstract");
      List<MethodNode> noCodeControls = new ArrayList<>();
      for (boolean nativeControl : List.of(true, false)) {
        decompiler.getRoot().getClasses().stream().flatMap(node -> node.getMethods().stream())
            .filter(method -> method.getCodeReader() == null
                && (nativeControl ? method.getAccessFlags().isNative() : method.getAccessFlags().isAbstract())
                && method.getParentClass().getMethods().stream()
                    .filter(candidate -> candidate.getAlias().equals(method.getAlias())).count() == 1)
            .findFirst().ifPresent(noCodeControls::add);
      }
      require(!noCodeControls.isEmpty(), "Fixture has no native/abstract negative control");
      JsonObject componentArgs = arguments("androidx.activity.ComponentActivity");
      JsonObject componentSummary = call(handle, bridge, "get_class_summary", componentArgs);
      List<String> signatures = new ArrayList<>();
      for (JsonElement entry : componentSummary.getAsJsonArray("methods")) {
        JsonObject method = entry.getAsJsonObject();
        if (method.get("name").getAsString().equals("setContentView"))
          signatures.add(method.get("signature").getAsString());
      }
      require(signatures.size() == 3, "Fixture must contain three setContentView overloads");
      String[] declarations = { "setContentView(int ", "setContentView(View ", "setContentView(View view, ViewGroup.LayoutParams " };
      for (int index = 0; index < signatures.size(); index++) {
        JsonObject methodArgs = arguments("androidx.activity.ComponentActivity");
        methodArgs.addProperty("method_name", "setContentView");
        methodArgs.addProperty("overload_index", index);
        JsonObject first = call(handle, bridge, "get_method_body", methodArgs);
        require(first.equals(call(handle, bridge, "get_method_body", methodArgs)), "Repeated body changed");
        require(first.get("overload_index").getAsInt() == index && first.get("overload_count").getAsInt() == 3,
            "Overload envelope mismatch");
        require(first.get("mode").getAsString().equals("java"), "Fixture did not produce Java");
        require(first.get("body").getAsString().contains(declarations[index]), "Wrong overload: " + signatures.get(index));
      }
      require(componentSummary.equals(call(handle, bridge, "get_class_summary", componentArgs)),
          "Frozen summary changed after code generation");
      require(apiSummary.equals(call(handle, bridge, "get_class_summary", apiArgs)), "Unrelated frozen summary changed");
      for (MethodNode control : noCodeControls) {
        JsonObject controlArgs = arguments(control.getParentClass().getFullName());
        controlArgs.addProperty("method_name", control.getAlias());
        JsonObject result = call(handle, bridge, "get_method_body", controlArgs);
        require(result.get("mode").getAsString().equals("java") && !result.get("fell_back").getAsBoolean()
            && !result.getAsJsonArray("markers").contains(new JsonPrimitive("java-body-not-emitted")),
            "Native/abstract method incorrectly used initializer fallback: " + control.getMethodInfo());
        System.out.println("PASS no-code control " + control.getMethodInfo());
      }
      JsonObject firstInitializer = initializer(handle, bridge);
      require(apiSummary.equals(call(handle, bridge, "get_class_summary", apiArgs)),
          "Frozen initializer metadata changed after fallback");
      JsonObject onCreateArgs = arguments("io.appium.android.apis.ApiDemos");
      onCreateArgs.addProperty("method_name", "onCreate");
      JsonObject beforeUnload = call(handle, bridge, "get_method_body", onCreateArgs);
      decompiler.searchJavaClassByOrigFullName("io.appium.android.apis.ApiDemos").unload();
      JsonObject afterUnload = call(handle, bridge, "get_method_body", onCreateArgs);
      String beforeBody = beforeUnload.remove("body").getAsString();
      String afterBody = afterUnload.remove("body").getAsString();
      require(beforeUnload.equals(afterUnload), "Ordinary method identity changed after provider cache eviction");
      // The audited engine can omit its synthesized @Override annotation after reloading.
      int beforeDeclaration = beforeBody.indexOf("public void onCreate(");
      int afterDeclaration = afterBody.indexOf("public void onCreate(");
      require(beforeDeclaration >= 0 && afterDeclaration >= 0
          && beforeBody.substring(beforeDeclaration).equals(afterBody.substring(afterDeclaration)),
          "Ordinary method declaration or instructions changed after provider cache eviction");
      BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> holder.unload(continuation));
      BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> holder.load(args[0], config, continuation));
      require(apiSummary.equals(call(handle, bridge, "get_class_summary", apiArgs)),
          "Reloaded fixture changed parsed metadata");
      JsonObject onCreate = call(handle, bridge, "get_method_body", onCreateArgs);
      require(onCreate.get("mode").getAsString().equals("java")
          && onCreate.get("body").getAsString().contains("setListAdapter"),
          "Ordinary method must generate usable Java before initializer lookup");
      require(firstInitializer.equals(initializer(handle, bridge)),
          "Initializer evidence depends on which method generated class source first");
      System.out.println("PASS folded initializer instructions, stable lookups and ordinary-method-first order");
      System.out.println("METADATA_REGRESSION_PASS classes=" + states.size() + " overloads=" + signatures.size());
    } finally {
      BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> holder.unload(continuation));
    }
  }
}
